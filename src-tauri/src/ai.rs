//! In-app model access over the OpenAI-compatible chat API, which Ollama, LM
//! Studio, llama.cpp and most hosted providers all speak. Local servers are
//! auto-detected; API keys live in the OS keychain, never in files.
//!
//! Notes go to whatever server is configured, so every URL passes `endpoint()`:
//! https anywhere, plain http only on this machine or the local network, and API
//! keys only over https or to this machine. Redirects are not followed, so a
//! server can't forward a request (and the note text in it) somewhere else.

use crate::vault::{Res, err};
use serde::Serialize;
use serde_json::{Value, json};
use std::io::BufRead;
use std::net::IpAddr;
use std::time::Duration;

/// Well-known local servers, probed on localhost only.
const LOCAL: [(&str, &str); 3] = [
    ("Ollama", "http://127.0.0.1:11434/v1"),
    ("LM Studio", "http://127.0.0.1:1234/v1"),
    ("llama.cpp", "http://127.0.0.1:8080/v1"),
];

#[derive(Serialize)]
pub struct Endpoint {
    pub name: &'static str,
    pub base_url: &'static str,
    pub models: Vec<String>,
}

/// A model server URL that passed the transport rules.
struct Server {
    base: String,
    /// https, or this machine: safe to send an API key to.
    private: bool,
}

/// This machine (`localhost`, 127.x, ::1).
fn loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// The local network: private and link-local addresses, `.local` names, and single-label
/// names like `gaming-pc`, which don't resolve on the public internet.
fn local_network(host: &str) -> bool {
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(IpAddr::V6(ip)) => ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local(),
        Err(_) => !host.contains('.') || host.to_ascii_lowercase().ends_with(".local"),
    }
}

fn endpoint(url: &str) -> Res<Server> {
    let base = url.trim().trim_end_matches('/').to_string();
    let invalid = || format!("Not a valid URL: {base}");
    let uri: ureq::http::Uri = base.parse().map_err(|_| invalid())?;
    let authority = uri.authority().ok_or_else(invalid)?;
    if authority.as_str().contains('@') {
        return Err("Remove the username/password from the URL and use the API key field instead.".into());
    }
    let host = authority.host().trim_start_matches('[').trim_end_matches(']');
    match uri.scheme_str() {
        Some("https") => Ok(Server { base, private: true }),
        Some("http") if local_network(host) => Ok(Server {
            private: loopback(host),
            base,
        }),
        Some("http") => Err(format!(
            "{base}: use https. Plain http is only allowed on this computer or your local network."
        )),
        _ => Err(format!(
            "{base}: the URL must start with https:// (or http:// on your local network)."
        )),
    }
}

fn key_entry(base_url: &str) -> Res<keyring::Entry> {
    keyring::Entry::new("FermiVault", &endpoint(base_url)?.base).map_err(err)
}

pub fn set_key(base_url: &str, key: Option<&str>) -> Res<()> {
    let e = key_entry(base_url)?;
    match key.filter(|k| !k.trim().is_empty()) {
        Some(_) if !endpoint(base_url)?.private => {
            Err("API keys are only sent over https (or to this computer). Use an https URL for this server.".into())
        }
        Some(k) => e.set_password(k.trim()).map_err(err),
        None => match e.delete_credential() {
            Err(keyring::Error::NoEntry) => Ok(()),
            r => r.map_err(err),
        },
    }
}

fn key(base_url: &str) -> Option<String> {
    key_entry(base_url).ok()?.get_password().ok()
}

pub fn has_key(base_url: &str) -> bool {
    key(base_url).is_some()
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(timeout))
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .into()
}

fn with_auth<T>(req: ureq::RequestBuilder<T>, server: &Server) -> ureq::RequestBuilder<T> {
    match key(&server.base).filter(|_| server.private) {
        Some(k) => req.header("Authorization", &format!("Bearer {k}")),
        None => req,
    }
}

/// Model ids served at `base_url` (`GET /models`).
pub fn models(base_url: &str) -> Res<Vec<String>> {
    let server = endpoint(base_url)?;
    let url = format!("{}/models", server.base);
    let mut resp = with_auth(agent(Duration::from_millis(1500)).get(&url), &server)
        .call()
        .map_err(err)?;
    if !resp.status().is_success() {
        return Err(format!("{url}: HTTP {}", resp.status()));
    }
    let v: Value = resp.body_mut().read_json().map_err(err)?;
    let mut ids: Vec<String> = v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m["id"].as_str().map(String::from))
        .collect();
    ids.sort();
    Ok(ids)
}

/// Local model servers that are running right now, with their models.
pub fn detect() -> Vec<Endpoint> {
    let probes: Vec<_> = LOCAL
        .iter()
        .map(|&(name, url)| {
            std::thread::spawn(move || {
                models(url).ok().map(|models| Endpoint {
                    name,
                    base_url: url,
                    models,
                })
            })
        })
        .collect();
    probes.into_iter().filter_map(|p| p.join().ok().flatten()).collect()
}

/// Streams a chat completion, calling `on_delta` with each text fragment.
/// Returning `false` from `on_delta` stops the stream (user pressed Stop).
pub fn chat(base_url: &str, model: &str, messages: &Value, mut on_delta: impl FnMut(&str) -> bool) -> Res<()> {
    let server = endpoint(base_url)?;
    let url = format!("{}/chat/completions", server.base);
    let body = json!({ "model": model, "messages": messages, "stream": true });
    let mut resp = with_auth(agent(Duration::from_secs(5)).post(&url), &server)
        .send_json(&body)
        .map_err(|e| format!("{url}: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.body_mut().read_to_string().unwrap_or_default();
        return Err(format!("{status}: {}", text.chars().take(400).collect::<String>()));
    }
    // Server-sent events: `data: {json}` lines, terminated by `data: [DONE]`.
    for line in std::io::BufReader::new(resp.body_mut().as_reader()).lines() {
        let line = line.map_err(err)?;
        let Some(data) = line.strip_prefix("data:").map(str::trim) else {
            continue;
        };
        if data == "[DONE]" {
            break;
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
        if let Some(e) = v.get("error") {
            return Err(e["message"].as_str().unwrap_or("model error").to_string());
        }
        if let Some(t) = v["choices"][0]["delta"]["content"].as_str()
            && !t.is_empty()
            && !on_delta(t)
        {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn endpoint_rules() {
        for ok in [
            "https://api.example.com/v1/",
            "http://127.0.0.1:11434/v1",
            "http://localhost:1234/v1",
            "http://[::1]:8080/v1",
            "http://192.168.1.20:11434/v1",
            "http://10.0.0.5/v1",
            "http://gaming-pc:11434/v1",
            "http://studio.local:1234/v1",
        ] {
            assert!(endpoint(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://api.example.com/v1",
            "http://8.8.8.8/v1",
            "http://localhost.evil.com/v1",
            "http://127.0.0.1.nip.io/v1",
            "https://user:pass@api.example.com/v1",
            "ftp://example.com",
            "api.example.com/v1",
            "",
        ] {
            assert!(endpoint(bad).is_err(), "{bad}");
        }
        // Keys only over https or to this machine, never plain http on the LAN.
        assert!(endpoint("https://api.example.com").unwrap().private);
        assert!(endpoint("http://localhost:11434").unwrap().private);
        assert!(!endpoint("http://192.168.1.20:11434").unwrap().private);
        assert!(set_key("http://192.168.1.20:11434", Some("k")).is_err());
    }

    /// Reads a whole HTTP request (headers + body) so the fake server never closes a socket
    /// with unread data, which makes Windows reset the connection.
    fn read_request(s: &mut std::net::TcpStream) {
        let mut req = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = s.read(&mut buf).unwrap();
            req.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&req);
            if let Some(end) = text.find("\r\n\r\n") {
                let len = text[..end]
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if req.len() >= end + 4 + len {
                    return;
                }
            }
            if n == 0 {
                return;
            }
        }
    }

    /// A server answering with a redirect must not get the request (and its note text) forwarded.
    #[test]
    fn redirects_are_not_followed() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            read_request(&mut s);
            write!(
                s,
                "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://192.0.2.1/x\r\nContent-Length: 0\r\n\r\n"
            )
            .unwrap();
        });
        let e = chat(&format!("http://{addr}/v1"), "m", &json!([]), |_| true).unwrap_err();
        assert!(e.starts_with("307"), "{e}");
    }

    /// A one-shot fake OpenAI-compatible server streaming two deltas.
    #[test]
    fn streams_sse_deltas() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            read_request(&mut s);
            let body = "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n\
                        data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\ndata: [DONE]\n\n";
            write!(
                s,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        });
        let mut out = String::new();
        chat(&format!("http://{addr}/v1/"), "m", &json!([]), |t| {
            out.push_str(t);
            true
        })
        .unwrap();
        assert_eq!(out, "Hello");
    }
}

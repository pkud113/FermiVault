//! In-app model access over the OpenAI-compatible chat API, which Ollama, LM
//! Studio, llama.cpp and most hosted providers all speak. Local servers are
//! auto-detected; API keys live in the OS keychain, never in files.

use crate::vault::{Res, err};
use serde::Serialize;
use serde_json::{Value, json};
use std::io::BufRead;
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

fn base(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

fn key_entry(base_url: &str) -> Res<keyring::Entry> {
    keyring::Entry::new("FermiVault", &base(base_url)).map_err(err)
}

pub fn set_key(base_url: &str, key: Option<&str>) -> Res<()> {
    let e = key_entry(base_url)?;
    match key.filter(|k| !k.trim().is_empty()) {
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
        .build()
        .into()
}

fn with_auth<T>(req: ureq::RequestBuilder<T>, base_url: &str) -> ureq::RequestBuilder<T> {
    match key(base_url) {
        Some(k) => req.header("Authorization", &format!("Bearer {k}")),
        None => req,
    }
}

/// Model ids served at `base_url` (`GET /models`).
pub fn models(base_url: &str) -> Res<Vec<String>> {
    let url = format!("{}/models", base(base_url));
    let mut resp = with_auth(agent(Duration::from_millis(1500)).get(&url), base_url)
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
    let url = format!("{}/chat/completions", base(base_url));
    let body = json!({ "model": model, "messages": messages, "stream": true });
    let mut resp = with_auth(agent(Duration::from_secs(5)).post(&url), base_url)
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

    /// A one-shot fake OpenAI-compatible server streaming two deltas.
    #[test]
    fn streams_sse_deltas() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            // Read the whole request (headers + JSON body) before replying; closing a
            // socket with unread data makes Windows reset the connection.
            let mut req = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = s.read(&mut buf).unwrap();
                req.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&req);
                if let Some(end) = text.find("\r\n\r\n") {
                    let len = text[..end]
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    if req.len() >= end + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
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

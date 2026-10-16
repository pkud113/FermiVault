//! Fetches a web page for the web clipper. Extraction (defuddle) and the note itself happen in
//! the frontend; this only downloads the HTML, with limits: http(s) only, HTML only, 5 MB, 20 s.

use crate::vault::{Res, err};
use serde::Serialize;
use std::time::Duration;
use ureq::ResponseExt;

const MAX_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Serialize, Debug)]
pub struct Page {
    /// Address after redirects, so relative links and the `source` property are right.
    pub url: String,
    pub html: String,
}

pub fn fetch(url: &str) -> Res<Page> {
    let url = url.trim();
    let uri: ureq::http::Uri = url.parse().map_err(|_| format!("Not a web address: {url}"))?;
    if !matches!(uri.scheme_str(), Some("http" | "https")) || uri.host().is_none() {
        return Err(format!("Only http:// and https:// pages can be clipped: {url}"));
    }
    if uri.authority().is_some_and(|a| a.as_str().contains('@')) {
        return Err("Remove the username/password from the address.".into());
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .max_redirects(5)
        .http_status_as_error(false)
        // Some sites refuse unknown clients; identify as a browser-like reader.
        .user_agent("Mozilla/5.0 (compatible; FermiVault web clipper)")
        .build()
        .into();
    let mut resp = agent
        .get(url)
        .header("Accept", "text/html,application/xhtml+xml")
        .call()
        .map_err(|e| format!("{url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("{url}: HTTP {}", resp.status()));
    }
    let final_url = resp.get_uri().to_string();
    let ctype = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ctype.is_empty() && !ctype.contains("html") {
        return Err(format!("{url} isn't a web page ({ctype})"));
    }
    let html = resp
        .body_mut()
        .with_config()
        .limit(MAX_BYTES)
        .read_to_string()
        .map_err(|e| format!("{url}: {}", err(e)))?;
    Ok(Page { url: final_url, html })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// One-shot HTTP server answering with `status`, `ctype` and `body`.
    fn serve(status: &'static str, ctype: &'static str, body: String) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf); // GET has no body: one read gets the request
            let _ = write!(
                s,
                "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
        });
        format!("http://{addr}/article")
    }

    #[test]
    fn fetches_html_pages() {
        let url = serve("200 OK", "text/html; charset=utf-8", "<html><title>Hi</title></html>".into());
        let p = fetch(&url).unwrap();
        assert_eq!(p.url, url);
        assert!(p.html.contains("<title>Hi</title>"));
    }

    #[test]
    fn refuses_what_it_shouldnt_clip() {
        for bad in [
            "file:///etc/passwd",
            "ftp://example.com/x",
            "javascript:alert(1)",
            "not a url",
            "https://user:pw@example.com/",
        ] {
            assert!(fetch(bad).is_err(), "{bad}");
        }
        assert!(
            fetch(&serve("200 OK", "application/pdf", "%PDF".into()))
                .unwrap_err()
                .contains("isn't a web page")
        );
        assert!(
            fetch(&serve("404 Not Found", "text/html", "nope".into()))
                .unwrap_err()
                .contains("404")
        );
        let huge = "x".repeat(MAX_BYTES as usize + 10);
        assert!(fetch(&serve("200 OK", "text/html", huge)).is_err(), "pages over 5 MB are refused");
    }
}

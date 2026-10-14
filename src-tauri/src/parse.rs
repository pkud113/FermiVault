//! Markdown fact extraction: links, tags, headings. Regex over code-stripped lines,
//! which is fast and good enough for indexing (rendering is the editor's job).

use regex::Regex;
use std::sync::LazyLock;

#[derive(Debug, Default, PartialEq)]
pub struct Parsed {
    /// (normalized link key, 1-based line, line text)
    pub links: Vec<(String, usize, String)>,
    pub tags: Vec<String>,
    /// (level, text, 1-based line)
    pub headings: Vec<(u8, String, usize)>,
}

static WIKI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!?\[\[([^\]\|#\^]*)(?:[#\^][^\]\|]*)?(?:\|[^\]]*)?\]\]").unwrap());
static MDLINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[[^\]]*\]\(<?([^)>\s]+?\.md)>?(?:#[^)]*)?\)").unwrap());
static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)").unwrap());
static HEADING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(#{1,6})\s+(.+?)\s*#*\s*$").unwrap());
static INLINE_CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`[^`]*`").unwrap());

/// Lowercased link target without `.md` or `./`, the form stored in the index.
pub fn link_key(target: &str) -> String {
    let t = target.trim().trim_start_matches("./").replace('\\', "/");
    let t = t.strip_suffix(".md").unwrap_or(&t);
    t.to_lowercase()
}

/// Joins a relative markdown link onto the source note's folder, resolving `..`.
pub fn resolve_relative(src: &str, href: &str) -> String {
    let href = href.replace("%20", " ");
    let mut parts: Vec<&str> = src.split('/').collect();
    parts.pop();
    for seg in href.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

/// Byte range of the YAML frontmatter block (including fences), if any.
pub fn frontmatter_end(text: &str) -> usize {
    if !(text.starts_with("---\n") || text.starts_with("---\r\n")) {
        return 0;
    }
    let mut pos = text.find('\n').unwrap() + 1;
    for line in text[pos..].split_inclusive('\n') {
        pos += line.len();
        if line.trim_end() == "---" {
            return pos;
        }
    }
    0
}

/// `src` is the vault-relative path of the note being parsed.
pub fn parse(src: &str, text: &str) -> Parsed {
    let mut out = Parsed::default();
    let fm_end = frontmatter_end(text);
    let fm_lines = text[..fm_end].lines().count();

    // Frontmatter tags: `tags: [a, b]`, `tags: a, b`, or a `- a` list.
    let mut in_tags = false;
    for line in text[..fm_end].lines() {
        if let Some(rest) = line.strip_prefix("tags:") {
            in_tags = true;
            let rest = rest.trim().trim_matches(['[', ']']);
            out.tags.extend(
                rest.split(',')
                    .map(|t| t.trim().trim_matches(['"', '\'', '#']).to_string())
                    .filter(|t| !t.is_empty()),
            );
        } else if in_tags && line.trim_start().starts_with("- ") {
            out.tags
                .push(line.trim_start()[2..].trim().trim_matches(['"', '\'', '#']).to_string());
        } else {
            in_tags = false;
        }
    }

    let mut fence: Option<&str> = None;
    for (i, raw) in text.lines().enumerate().skip(fm_lines) {
        let lineno = i + 1;
        let trimmed = raw.trim_start();
        if let Some(f) = fence {
            if trimmed.starts_with(f) {
                fence = None;
            }
            continue;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fence = Some(&trimmed[..3]);
            continue;
        }
        if let Some(c) = HEADING.captures(raw) {
            out.headings.push((c[1].len() as u8, c[2].to_string(), lineno));
        }
        let line = INLINE_CODE.replace_all(raw, "");
        for c in WIKI.captures_iter(&line) {
            let key = link_key(&c[1]);
            if !key.is_empty() {
                out.links.push((key, lineno, raw.trim().to_string()));
            }
        }
        for c in MDLINK.captures_iter(&line) {
            if !c[1].contains("://") {
                out.links
                    .push((link_key(&resolve_relative(src, &c[1])), lineno, raw.trim().to_string()));
            }
        }
        // Heading markers (`## x`) never match: a tag needs a non-space right after `#`.
        out.tags.extend(TAG.captures_iter(&line).map(|c| c[1].to_string()));
    }
    out.tags.sort();
    out.tags.dedup();
    out
}

#[derive(Debug, PartialEq)]
pub struct Chunk {
    /// Nearest heading above the chunk ("" before the first heading).
    pub heading: String,
    /// 1-based line where the chunk starts.
    pub line: usize,
    pub text: String,
}

/// Target chunk size for embeddings/retrieval: big enough to carry meaning,
/// small enough that a search hit points at the right paragraph.
const CHUNK_CHARS: usize = 1200;

/// Splits a note into retrieval chunks: one per heading section, with long
/// sections packed paragraph-by-paragraph up to `CHUNK_CHARS`.
pub fn chunks(text: &str) -> Vec<Chunk> {
    let fm_lines = text[..frontmatter_end(text)].lines().count();
    let mut out: Vec<Chunk> = Vec::new();
    let (mut heading, mut fence) = (String::new(), false);
    let mut cur = Chunk {
        heading: String::new(),
        line: fm_lines + 1,
        text: String::new(),
    };
    let flush = |cur: &mut Chunk, out: &mut Vec<Chunk>, heading: &str, next_line: usize| {
        if !cur.text.trim().is_empty() {
            let text = std::mem::take(&mut cur.text).trim().to_string();
            out.push(Chunk {
                heading: cur.heading.clone(),
                line: cur.line,
                text,
            });
        }
        *cur = Chunk {
            heading: heading.to_string(),
            line: next_line,
            text: String::new(),
        };
    };
    for (i, line) in text.lines().enumerate().skip(fm_lines) {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = !fence;
        }
        let new_heading = (!fence).then(|| HEADING.captures(line)).flatten();
        if let Some(c) = new_heading {
            heading = c[2].to_string();
            flush(&mut cur, &mut out, &heading, i + 1);
        } else if !fence && line.trim().is_empty() && cur.text.len() >= CHUNK_CHARS {
            flush(&mut cur, &mut out, &heading, i + 2);
        }
        cur.text.push_str(line);
        cur.text.push('\n');
    }
    flush(&mut cur, &mut out, &heading, 0);
    out
}

/// Returns the byte range of the section under `heading` (heading line through the
/// line before the next heading of the same or higher level).
pub fn section_range(text: &str, heading: &str) -> Option<(usize, usize)> {
    let want = heading.trim().trim_start_matches('#').trim().to_lowercase();
    let mut start: Option<(usize, usize)> = None; // (byte offset, level)
    let mut pos = 0;
    let mut fence = false;
    for line in text.split_inclusive('\n') {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = !fence;
        }
        if !fence && let Some(c) = HEADING.captures(line.trim_end()) {
            let level = c[1].len();
            match start {
                Some((s, l)) if level <= l => return Some((s, pos)),
                None if c[2].to_lowercase() == want => start = Some((pos, level)),
                _ => {}
            }
        }
        pos += line.len();
    }
    start.map(|(s, _)| (s, text.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_links_tags_headings() {
        let text = "---\ntags: [alpha, \"beta\"]\n---\n# Title #inh\nSee [[Other Note|alias]] and [[folder/Deep#sec]].\n\
                    ![[img.png]] [md](../x/Y.md) [web](https://a.md) #tag/nested #123 `[[not]] #not`\n\
                    ```\n[[nope]] #nope\n```\n## Sub";
        let p = parse("notes/a.md", text);
        let keys: Vec<_> = p.links.iter().map(|l| l.0.as_str()).collect();
        assert_eq!(keys, ["other note", "folder/deep", "img.png", "x/y"]);
        assert_eq!(p.links[0].1, 5);
        assert_eq!(p.tags, ["alpha", "beta", "inh", "tag/nested"]);
        assert_eq!(p.headings, vec![(1, "Title #inh".into(), 4), (2, "Sub".into(), 10)]);
    }

    #[test]
    fn frontmatter_list_tags() {
        let p = parse("a.md", "---\ntags:\n  - one\n  - two\ntitle: x\n---\nbody #three");
        assert_eq!(p.tags, ["one", "three", "two"]);
    }

    #[test]
    fn chunking() {
        let long = "word ".repeat(300); // ~1500 chars
        let text = format!("---\ntags: [a]\n---\nintro\n# A\none\n```\n# not a heading\n```\n## B\n{long}\n\n{long}\n\nend\n");
        let c = chunks(&text);
        assert_eq!(
            c[0],
            Chunk {
                heading: "".into(),
                line: 4,
                text: "intro".into()
            }
        );
        assert_eq!((c[1].heading.as_str(), c[1].line), ("A", 5));
        assert!(c[1].text.contains("# not a heading"), "fenced code stays in its section");
        assert_eq!(c[2].heading, "B");
        assert_eq!(c.len(), 5, "long section split on paragraph boundaries");
        assert!(c[2..].iter().all(|x| x.heading == "B"));
        assert!(chunks("").is_empty());
    }

    #[test]
    fn sections() {
        let t = "# A\na\n## B\nb\n```\n# not\n```\n### C\nc\n## D\nd\n";
        let (s, e) = section_range(t, "b").unwrap();
        assert_eq!(&t[s..e], "## B\nb\n```\n# not\n```\n### C\nc\n");
        let (s, e) = section_range(t, "## D").unwrap();
        assert_eq!(&t[s..e], "## D\nd\n");
        assert!(section_range(t, "zzz").is_none());
    }
}

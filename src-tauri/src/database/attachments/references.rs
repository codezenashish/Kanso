use pulldown_cmark::{Event, LinkType, Options, Parser, Tag};
use regex::Regex;
use std::{collections::BTreeMap, ops::Range, sync::LazyLock};

const ID: &str = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
pub(super) static REFERENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("(?i)attachment:({ID})")).unwrap());
static DESTINATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?i)^attachment:({ID})(#[^\s]*)?$")).unwrap());
static INLINE_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\]\([\t\r\n ]*<?([^\s()>]+)").unwrap());
static DEFINITION_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\]:[\t\r\n ]*<?([^\s()>]+)").unwrap());

fn parse(content: &str) -> Parser<'_> {
    Parser::new_ext(
        content,
        Options::ENABLE_TABLES
            | Options::ENABLE_FOOTNOTES
            | Options::ENABLE_GFM
            | Options::ENABLE_STRIKETHROUGH
            | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS,
    )
}

pub(in crate::database) fn ids_in(content: &str) -> impl Iterator<Item = String> + '_ {
    let raw = REFERENCE
        .captures_iter(content)
        .map(|capture| capture[1].to_ascii_lowercase());
    // Source can spell any part of the URL with Markdown escapes or character references.
    let parsed = (content.contains('&') || content.contains('\\')).then(|| {
        let parser = parse(content);
        let definitions: Vec<_> = parser
            .reference_definitions()
            .iter()
            .filter_map(|(_, def)| destination(&def.dest).map(|(id, _)| id))
            .collect();
        definitions
            .into_iter()
            .chain(parser.filter_map(|event| match event {
                Event::Start(Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. }) => {
                    destination(&dest_url).map(|(id, _)| id)
                }
                _ => None,
            }))
    });
    raw.chain(parsed.into_iter().flatten())
}

fn destination(url: &str) -> Option<(String, String)> {
    let capture = DESTINATION.captures(url)?;
    Some((
        capture[1].to_ascii_lowercase(),
        capture.get(2).map_or("", |part| part.as_str()).to_owned(),
    ))
}

struct LinkLocation {
    id: String,
    fragment: String,
    autolink: bool,
}

fn locate_url(
    content: &str,
    span: Range<usize>,
    pattern: &Regex,
    decoded: &str,
) -> Option<Range<usize>> {
    for capture in pattern.captures_iter(&content[span.clone()]) {
        let token = capture.get(1)?;
        let matches = token.as_str() == decoded || parse(&format!("[x](<{}>)", token.as_str()))
            .any(|event| matches!(event, Event::Start(Tag::Link { dest_url, .. }) if dest_url.as_ref() == decoded));
        if matches {
            return Some(span.start + token.start()..span.start + token.end());
        }
    }
    None
}

pub(super) fn rewrite_markdown(
    content: &str,
    replacement: impl Fn(&str, &str) -> Result<Option<String>, super::AttachmentError>,
) -> Result<String, super::AttachmentError> {
    let parser = parse(content);
    let mut locations = BTreeMap::new();
    for (_, def) in parser.reference_definitions().iter() {
        if let Some((id, fragment)) = destination(&def.dest) {
            let start = locate_url(content, def.span.clone(), &DEFINITION_URL, &def.dest);
            if let Some(range) = start {
                locations.insert(
                    range.start,
                    (
                        range.end,
                        LinkLocation {
                            id,
                            fragment,
                            autolink: false,
                        },
                    ),
                );
            } else if replacement(&id, &fragment)?.is_some() {
                return Err(super::AttachmentError::InvalidBackup);
            }
        }
    }
    for (event, span) in parser.into_offset_iter() {
        if let Event::Start(
            Tag::Link {
                link_type,
                dest_url,
                ..
            }
            | Tag::Image {
                link_type,
                dest_url,
                ..
            },
        ) = event
            && let Some((id, fragment)) = destination(&dest_url)
        {
            let range = match link_type {
                LinkType::Inline => locate_url(content, span, &INLINE_URL, &dest_url),
                LinkType::Autolink => Some(span),
                _ => continue,
            };
            if let Some(range) = range {
                locations.insert(
                    range.start,
                    (
                        range.end,
                        LinkLocation {
                            id,
                            fragment,
                            autolink: link_type == LinkType::Autolink,
                        },
                    ),
                );
            } else if replacement(&id, &fragment)?.is_some() {
                return Err(super::AttachmentError::InvalidBackup);
            }
        }
    }

    let mut output = content.to_owned();
    for (start, (end, location)) in locations.into_iter().rev() {
        if let Some(url) = replacement(&location.id, &location.fragment)? {
            let value = if location.autolink && !url.starts_with("attachment:") {
                format!("[Attachment]({url})")
            } else if location.autolink {
                format!("<{url}>")
            } else {
                url
            };
            output.replace_range(start..end, &value);
        }
    }
    Ok(output)
}

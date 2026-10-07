//! Recover missing Identity-H TrueType ToUnicode maps for *preview copies*.
//! Exact PostScript name + glyph-outline verification prevents guessing from a
//! similarly named but incompatible font. The paper PDF is never overwritten.
use fontdb::Database;
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream, StringFormat};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{LazyLock, Mutex},
};
use tauri::{AppHandle, Manager};
use ttf_parser::{Face, GlyphId, OutlineBuilder};
static FONTS: LazyLock<Mutex<Option<Database>>> = LazyLock::new(|| Mutex::new(None));
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    path: String,
    repaired_fonts: Vec<String>,
    warnings: Vec<String>,
}
#[derive(Default, PartialEq, Eq)]
struct Outline(Vec<(u8, Vec<u32>)>);
impl OutlineBuilder for Outline {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.push((0, vec![x.to_bits(), y.to_bits()]));
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.0.push((1, vec![x.to_bits(), y.to_bits()]));
    }
    fn quad_to(&mut self, x: f32, y: f32, x1: f32, y1: f32) {
        self.0.push((
            2,
            vec![x.to_bits(), y.to_bits(), x1.to_bits(), y1.to_bits()],
        ));
    }
    fn curve_to(&mut self, x: f32, y: f32, x1: f32, y1: f32, x2: f32, y2: f32) {
        self.0.push((
            3,
            vec![
                x.to_bits(),
                y.to_bits(),
                x1.to_bits(),
                y1.to_bits(),
                x2.to_bits(),
                y2.to_bits(),
            ],
        ));
    }
    fn close(&mut self) {
        self.0.push((4, vec![]));
    }
}
fn font_database() -> Database {
    let mut db = Database::new();
    db.load_system_fonts();
    // macOS downloadable fonts (including legacy STHeiti) are outside Fonts/.
    #[cfg(target_os = "macos")]
    if let Ok(entries) = std::fs::read_dir("/System/Library/AssetsV2") {
        for entry in entries.flatten() {
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with("com_apple_MobileAsset_Font")
            {
                db.load_fonts_dir(entry.path());
            }
        }
    }
    db
}
fn base_name(name: &str) -> &str {
    if name.len() > 7
        && name.as_bytes()[6] == b'+'
        && name.as_bytes()[..6].iter().all(u8::is_ascii_uppercase)
    {
        &name[7..]
    } else {
        name
    }
}
fn object<'a>(doc: &'a Document, value: &'a Object) -> Result<&'a Object, String> {
    match value {
        Object::Reference(id) => doc.get_object(*id).map_err(|e| e.to_string()),
        _ => Ok(value),
    }
}
fn dictionary_value<'a>(
    doc: &'a Document,
    dict: &'a Dictionary,
    key: &[u8],
) -> Result<&'a Dictionary, String> {
    object(doc, dict.get(key).map_err(|e| e.to_string())?)?
        .as_dict()
        .map_err(|e| e.to_string())
}
fn recover_map(embedded: &[u8], name: &str, db: &Database) -> Result<BTreeMap<u16, char>, String> {
    let subset = Face::parse(embedded, 0).map_err(|_| "嵌入字体无法解析".to_string())?;
    let glyphs: Vec<_> = (1..subset.number_of_glyphs())
        .filter_map(|id| {
            let mut outline = Outline::default();
            subset.outline_glyph(GlyphId(id), &mut outline)?;
            if outline.0.is_empty() {
                None
            } else {
                Some((id, outline))
            }
        })
        .collect();
    if glyphs.is_empty() {
        return Err("嵌入字体没有可核验的字形".into());
    }
    for info in db.faces().filter(|f| f.post_script_name == name) {
        let result = db
            .with_face_data(info.id, |data, index| {
                let original = Face::parse(data, index).ok()?;
                if subset.units_per_em() != original.units_per_em() {
                    return None;
                }
                for (id, expected) in &glyphs {
                    let mut outline = Outline::default();
                    original.outline_glyph(GlyphId(*id), &mut outline)?;
                    if &outline != expected {
                        return None;
                    }
                }
                let mut map = BTreeMap::new();
                for table in original.tables().cmap?.subtables {
                    if !table.is_unicode() {
                        continue;
                    }
                    table.codepoints(|code| {
                        if let (Some(ch), Some(gid)) =
                            (char::from_u32(code), table.glyph_index(code))
                        {
                            if gid.0 != 0 && gid.0 < subset.number_of_glyphs() && !ch.is_control() {
                                map.entry(gid.0)
                                    .and_modify(|old: &mut char| {
                                        if ch < *old {
                                            *old = ch;
                                        }
                                    })
                                    .or_insert(ch);
                            }
                        }
                    });
                }
                // Never claim success with an incomplete or wrong glyph mapping.
                if glyphs.iter().any(|(id, _)| !map.contains_key(id)) {
                    return None;
                }
                Some(map)
            })
            .flatten();
        if let Some(map) = result {
            return Ok(map);
        }
    }
    Err("本机没有可通过字形校验的同版本字体".into())
}
fn cmap(map: &BTreeMap<u16, char>) -> Vec<u8> {
    let mut s=String::from("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Writer-Recovered-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n");
    let entries: Vec<_> = map.iter().collect();
    for chunk in entries.chunks(100) {
        s.push_str(&format!("{} beginbfchar\n", chunk.len()));
        for (gid, ch) in chunk {
            let mut units = [0u16; 2];
            let text = ch
                .encode_utf16(&mut units)
                .iter()
                .map(|v| format!("{v:04X}"))
                .collect::<String>();
            s.push_str(&format!("<{gid:04X}> <{text}>\n"));
        }
        s.push_str("endbfchar\n");
    }
    s.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    s.into_bytes()
}
fn repair(doc: &mut Document) -> (Vec<String>, Vec<String>, Vec<BTreeMap<u16, char>>) {
    let candidates: Vec<ObjectId> = doc
        .objects
        .iter()
        .filter_map(|(id, obj)| {
            let d = obj.as_dict().ok()?;
            (d.get(b"Subtype").ok()?.as_name().ok()? == b"Type0"
                && !d.has(b"ToUnicode")
                && matches!(
                    d.get(b"Encoding").ok()?.as_name().ok()?,
                    b"Identity-H" | b"Identity-V"
                ))
            .then_some(*id)
        })
        .collect();
    if candidates.is_empty() {
        return (vec![], vec![], vec![]);
    }
    let mut fonts = match FONTS.lock() {
        Ok(f) => f,
        Err(_) => return (vec![], vec!["字体映射检查不可用".into()], vec![]),
    };
    let db = fonts.get_or_insert_with(font_database);
    let mut repaired = vec![];
    let mut warnings = vec![];
    let mut maps = vec![];
    for id in candidates {
        let result = (|| -> Result<(String, BTreeMap<u16, char>), String> {
            let font = doc.get_dictionary(id).map_err(|e| e.to_string())?;
            let name = String::from_utf8_lossy(
                font.get(b"BaseFont")
                    .map_err(|e| e.to_string())?
                    .as_name()
                    .map_err(|e| e.to_string())?,
            )
            .into_owned();
            let descendant = object(
                doc,
                font.get(b"DescendantFonts").map_err(|e| e.to_string())?,
            )?
            .as_array()
            .map_err(|e| e.to_string())?
            .first()
            .ok_or("无子字体")?;
            let descendant = object(doc, descendant)?
                .as_dict()
                .map_err(|e| e.to_string())?;
            if descendant.get(b"Subtype").and_then(Object::as_name).ok() != Some(b"CIDFontType2") {
                return Err(format!("{name} 缺少文字映射，暂不能可靠恢复"));
            }
            if descendant
                .get(b"CIDToGIDMap")
                .is_ok_and(|v| v.as_name().ok() != Some(b"Identity"))
            {
                return Err(format!("{name} 使用未支持的字形映射"));
            }
            let descriptor = dictionary_value(doc, descendant, b"FontDescriptor")?;
            let data = object(
                doc,
                descriptor
                    .get(b"FontFile2")
                    .map_err(|_| format!("{name} 未嵌入字体"))?,
            )?
            .as_stream()
            .map_err(|e| e.to_string())?
            .get_plain_content()
            .map_err(|e| e.to_string())?;
            if data.len() > 64 * 1024 * 1024 {
                return Err("字体过大".into());
            }
            let map =
                recover_map(&data, base_name(&name), db).map_err(|e| format!("{name}：{e}"))?;
            Ok((name, map))
        })();
        match result {
            Ok((name, map)) => {
                let stream = doc.add_object(Stream::new(dictionary! {}, cmap(&map)));
                if let Ok(font) = doc.get_dictionary_mut(id) {
                    font.set("ToUnicode", stream);
                    repaired.push(name);
                    maps.push(map);
                }
            }
            Err(e) => warnings.push(e),
        }
    }
    (repaired, warnings, maps)
}
fn prepare(path: &Path, cache: &Path) -> Result<Preview, String> {
    if std::fs::metadata(path).map_err(|e| e.to_string())?.len() > 256 * 1024 * 1024 {
        return Err("PDF 超过文字映射检查的大小上限".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > 256 * 1024 * 1024 {
        return Err("PDF 超过文字映射检查的大小上限".into());
    }
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let cached = cache.join(format!("v1-{hash}.pdf"));
    let manifest = cached.with_extension("json");
    // Most PDFs need no repair; remember that instead of re-parsing on every open/compile.
    let clean = cached.with_extension("clean");
    if clean.is_file() {
        touch(&clean);
        return Ok(Preview {
            path: path.to_string_lossy().into(),
            repaired_fonts: vec![],
            warnings: vec![],
        });
    }
    if cached.is_file() {
        if let Ok(saved) = std::fs::read(&manifest) {
            if let Ok(mut preview) = serde_json::from_slice::<Preview>(&saved) {
                touch(&cached);
                preview.path = cached.to_string_lossy().into();
                return Ok(preview);
            }
        }
    }
    let mut doc = Document::load_mem(&bytes).map_err(|e| e.to_string())?;
    let (repaired_fonts, warnings, _) = repair(&mut doc);
    let mut preview = Preview {
        path: path.to_string_lossy().into(),
        repaired_fonts,
        warnings,
    };
    if !preview.repaired_fonts.is_empty() {
        // Preserve PDF.js's fingerprint even when a source PDF has no /ID.
        if !doc.trailer.has(b"ID") {
            let id = md5::Md5::digest(&bytes[..bytes.len().min(1024)]).to_vec();
            doc.trailer.set(
                "ID",
                Object::Array(vec![
                    Object::String(id.clone(), StringFormat::Hexadecimal),
                    Object::String(id, StringFormat::Hexadecimal),
                ]),
            );
        }
        std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
        let temp = cache.join(format!("{}.tmp", uuid::Uuid::new_v4()));
        doc.save(&temp).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, &cached).map_err(|e| e.to_string())?;
        preview.path = cached.to_string_lossy().into();
        // Only cache a complete recovery; newly installed fonts can then fix prior warnings.
        if preview.warnings.is_empty() {
            std::fs::write(
                manifest,
                serde_json::to_vec(&preview).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        }
        prune(cache);
    } else if preview.warnings.is_empty() && std::fs::create_dir_all(cache).is_ok() {
        let _ = std::fs::write(&clean, b"");
        prune(cache);
    }
    Ok(preview)
}
fn touch(path: &Path) {
    let _ = std::fs::File::options()
        .write(true)
        .open(path)
        .and_then(|file| file.set_modified(std::time::SystemTime::now()));
}
/// Every recompiled PDF has a new hash; keep only recently used previews and markers.
fn prune(cache: &Path) {
    let Ok(entries) = std::fs::read_dir(cache) else {
        return;
    };
    let (mut previews, mut markers) = (vec![], vec![]);
    for entry in entries.flatten() {
        let path = entry.path();
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        match path.extension().and_then(|e| e.to_str()) {
            Some("pdf") => previews.push((modified, path)),
            Some("clean") => markers.push((modified, path)),
            Some("tmp") if modified.elapsed().is_ok_and(|age| age.as_secs() > 3600) => {
                let _ = std::fs::remove_file(path);
            }
            _ => {}
        }
    }
    for (limit, mut list) in [(16, previews), (512, markers)] {
        list.sort_by_key(|entry| std::cmp::Reverse(entry.0));
        for (_, path) in list.into_iter().skip(limit) {
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(path.with_extension("json"));
        }
    }
}
#[tauri::command]
pub async fn pdf_prepare_preview(
    app: AppHandle,
    project: String,
    pdf: String,
) -> Result<Preview, String> {
    let root = super::annotations::root(&project).await?;
    let path = super::annotations::project_file(&root, &pdf).await?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("pdf-text-previews");
    tokio::task::spawn_blocking(move || prepare(&path, &cache))
        .await
        .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cmap_handles_non_bmp_and_preserves_cid_numbers() {
        let text = String::from_utf8(cmap(&BTreeMap::from([(1, '有'), (200, '𠮷')]))).unwrap();
        assert!(text.contains("<0001> <6709>"));
        assert!(text.contains("<00C8> <D842DFB7>"));
    }
    #[test]
    fn preserves_existing_unicode_tables() {
        let mut doc = Document::with_version("1.5");
        let id=doc.add_object(dictionary!{"Type"=>"Font","Subtype"=>"Type0","BaseFont"=>"STHeiti","Encoding"=>"Identity-H","ToUnicode"=>Object::Null});
        assert!(repair(&mut doc).0.is_empty());
        assert!(doc.get_dictionary(id).unwrap().has(b"ToUnicode"));
    }
    #[test]
    #[ignore = "requires a local PDF with matching system fonts"]
    fn real_pdf_recovery() {
        let source = std::path::PathBuf::from(std::env::var("WRITER_PDF_QA_PATH").unwrap());
        let cache = tempfile::tempdir().unwrap();
        let before = std::fs::read(&source).unwrap();
        let preview = prepare(&source, cache.path()).unwrap();
        assert!(!preview.repaired_fonts.is_empty(), "{:?}", preview.warnings);
        assert!(preview.warnings.is_empty(), "{:?}", preview.warnings);
        assert_eq!(before, std::fs::read(&source).unwrap());
        if let Ok(output) = std::env::var("WRITER_PDF_QA_OUTPUT") {
            std::fs::copy(&preview.path, output).unwrap();
        }
        println!("recovered fonts: {:?}", preview.repaired_fonts);
    }
}

pub fn suspicious_quote(quote: &str) -> bool {
    quote
        .chars()
        .filter(|c| ('\u{3400}'..='\u{4dff}').contains(c))
        .take(2)
        .count()
        == 2
}
fn correct_quote(quote: &str, context: &str, map: &BTreeMap<u16, char>) -> String {
    let chars: Vec<char> = quote.chars().collect();
    let mut result = String::new();
    let mut i = 0;
    while i < chars.len() {
        let mut decoded = String::new();
        let mut raw = String::new();
        let mut best = None;
        for (j, ch) in chars.iter().enumerate().skip(i).take(128) {
            let Some(mapped) = u16::try_from(*ch as u32).ok().and_then(|id| map.get(&id)) else {
                break;
            };
            raw.push(*ch);
            decoded.push(*mapped);
            if j - i >= 3
                && suspicious_quote(&raw)
                && raw != decoded
                && !context.contains(&raw)
                && context.matches(&decoded).count() == 1
            {
                best = Some((j + 1, decoded.clone()));
            }
        }
        if let Some((end, text)) = best {
            result.push_str(&text);
            i = end;
        } else {
            result.push(chars[i]);
            i += 1;
        }
    }
    result
}
pub type QuoteCandidate = (String, String, String); // note ID, original quote, saved source context
pub fn recover_saved_quotes(
    bytes: &[u8],
    fingerprint: &str,
    candidates: &[QuoteCandidate],
) -> Result<Option<Vec<(String, String)>>, String> {
    let mut doc = Document::load_mem(bytes).map_err(|e| e.to_string())?;
    let id = doc
        .trailer
        .get(b"ID")
        .ok()
        .and_then(|v| v.as_array().ok())
        .and_then(|v| v.first())
        .and_then(|v| v.as_str().ok())
        .filter(|v| v.iter().any(|b| *b != 0))
        .map(|v| v.to_vec())
        .unwrap_or_else(|| md5::Md5::digest(&bytes[..bytes.len().min(1024)]).to_vec());
    if id.iter().map(|b| format!("{b:02x}")).collect::<String>() != fingerprint {
        return Ok(None);
    }
    let (_, _, maps) = repair(&mut doc);
    let mut changes = vec![];
    for (id, quote, context) in candidates {
        let mut recovered = quote.clone();
        for map in &maps {
            recovered = correct_quote(&recovered, context, map);
        }
        if recovered != *quote {
            changes.push((id.clone(), recovered));
        }
    }
    Ok(Some(changes))
}
#[cfg(test)]
mod quote_tests {
    use super::*;
    #[test]
    fn only_corrects_an_exact_unique_saved_source_match() {
        let raw = "㴱㨾㽔㜢㲓♛⛪ᮣ";
        let good = "运行状态与调度。";
        let map = raw
            .chars()
            .zip(good.chars())
            .map(|(a, b)| (a as u16, b))
            .collect();
        let quote = format!("{raw} 正文保留 S_t = (W, z_t)");
        assert_eq!(
            correct_quote(&quote, "\\paragraph{运行状态与调度。}", &map),
            "运行状态与调度。 正文保留 S_t = (W, z_t)"
        );
        assert_eq!(correct_quote(&quote, "另一个段落", &map), quote);
        assert_eq!(correct_quote(&quote, &format!("{good}{good}"), &map), quote);
        assert_eq!(correct_quote(raw, raw, &map), raw);
    }
}

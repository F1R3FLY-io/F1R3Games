//! Syntax-check Rholang with the node's parser.

pub fn parse(src: &str) -> Result<(), String> {
    let p = rholang_parser::RholangParser::new();
    match p.parse(src) {
        validated::Validated::Good(_) => Ok(()),
        validated::Validated::Fail(e) => Err(format!("{e:?}")),
    }
}

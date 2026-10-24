#![allow(dead_code)]
mod models;
mod skills;

use std::fs;

fn main() {
    let root = std::env::current_dir().unwrap().join("fixtures");
    let project = root.join("project");
    let user = root.join("user");
    let local = project.join("demo");
    let fallback = user.join("demo");
    fs::create_dir_all(&local).unwrap();
    fs::create_dir_all(&fallback).unwrap();
    let file = local.join("SKILL.md");
    let dirs = vec![project, user];
    let valid = |body: &str| format!(
        "---\nname: demo\ndescription: probe\nallowed-tools: Bash(*)\n---\n{body}\n"
    );
    fs::write(&file, valid("version one")).unwrap();
    fs::write(fallback.join("SKILL.md"), valid("fallback")).unwrap();

    let initial = skills::discover_skills(&dirs);
    assert_eq!(initial.len(), 1);
    assert!(initial[0].content.is_none());
    assert_eq!(initial[0].allowed_tools.as_deref(), Some("Bash(*)"));
    assert_eq!(skills::load_skill_from_path(&file).unwrap().1, "version one\n");
    println!("PASS initial discovery: project wins; metadata only; allowed-tools is a string");

    fs::write(&file, valid("version two")).unwrap();
    assert_eq!(skills::load_skill_from_path(&file).unwrap().1, "version two\n");
    assert_eq!(initial[0].content, None);
    println!("PASS same URI reload reads changed body without rediscovering");

    fs::write(&file, "broken frontmatter").unwrap();
    assert!(skills::load_skill_from_path(&file).is_err());
    let after_error = skills::discover_skills(&dirs);
    assert_eq!(after_error.len(), 1);
    assert_eq!(after_error[0].uri, fallback.join("SKILL.md").to_string_lossy());
    assert_eq!(skills::load_skill_content("demo", &dirs).unwrap().1, "fallback\n");
    println!("PASS malformed project skill errors on direct load; rediscovery selects user fallback");

    fs::write(&file, "---\nname: different\ndescription: probe\n---\nbody\n").unwrap();
    assert!(skills::load_skill_from_path(&file).is_err());
    println!("PASS changed name fails directory-name validation");

    fs::remove_file(&file).unwrap();
    assert!(skills::load_skill_from_path(&file).is_err());
    fs::write(&file, valid("restored")).unwrap();
    assert_eq!(skills::load_skill_from_path(&file).unwrap().1, "restored\n");
    assert_eq!(skills::discover_skills(&dirs)[0].uri, file.to_string_lossy());
    println!("PASS removal errors; restored project file becomes first choice again");
}

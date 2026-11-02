//! The MCP server as an agent sees it: the app's binary started with --mcp in a temporary home,
//! spoken to over its stdin and stdout.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::Duration;

struct Server { child: Child, input: ChildStdin, output: Receiver<Value>, next: u64 }

impl Server {
  fn start(home: &Path) -> Self {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tabtasker-dictate")).arg("--mcp").env("HOME", home)
      .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap();
    let (input, stdout) = (child.stdin.take().unwrap(), child.stdout.take().unwrap());
    let (send, output) = channel();
    std::thread::spawn(move || for line in BufReader::new(stdout).lines().map_while(Result::ok) {
      if send.send(serde_json::from_str(&line).unwrap_or_else(|_| panic!("not JSON: {line}"))).is_err() { return; }
    });
    Self { child, input, output, next: 0 }
  }

  fn line(&mut self, line: &str) {
    self.input.write_all(format!("{line}\n").as_bytes()).unwrap();
    self.input.flush().unwrap();
  }

  fn message(&self) -> Value { self.output.recv_timeout(Duration::from_secs(10)).expect("the server answers") }

  /// The answer to `method`, skipping notifications.
  fn ask(&mut self, method: &str, params: Value) -> Value {
    self.next += 1;
    let id = self.next;
    self.line(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string());
    loop {
      let message = self.message();
      if message.get("method").is_some() { continue; }
      assert_eq!(message["id"], id, "{message}");
      return message;
    }
  }

  fn tools(&mut self) -> Vec<String> {
    self.ask("tools/list", json!({}))["result"]["tools"].as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap().to_owned()).collect()
  }

  /// A tool's result, and whether it is an error.
  fn call(&mut self, name: &str, arguments: Value) -> (Value, bool) {
    let answer = self.ask("tools/call", json!({ "name": name, "arguments": arguments }));
    let result = answer["result"].clone();
    assert!(result.is_object(), "{answer}");
    let error = result["isError"].as_bool().unwrap();
    (result, error)
  }

  fn text(&mut self, name: &str, arguments: Value) -> String {
    let (result, error) = self.call(name, arguments);
    assert!(!error, "{name}: {result}");
    result["content"][0]["text"].as_str().unwrap().to_owned()
  }
}

fn write(path: &Path, text: &str) {
  std::fs::create_dir_all(path.parent().unwrap()).unwrap();
  std::fs::write(path, text).unwrap();
}

fn settings(home: &Path, agents: Value) { settings_with(home, json!({ "agents": agents })); }

fn settings_with(home: &Path, mut more: Value) {
  more["version"] = json!(1);
  more["history"] = json!({ "keep": "week" });
  write(&home.join("Library/Application Support/com.tabtasker.dictate/settings.json"), &more.to_string());
}

fn home(name: &str) -> PathBuf {
  let home = std::env::temp_dir().join(format!("dictate-mcp-server-{name}-{}", std::process::id()));
  let _ = std::fs::remove_dir_all(&home);
  std::fs::create_dir_all(&home).unwrap();
  let home = home.canonicalize().unwrap();
  let notes = home.join("Documents/TabTasker Dictate");
  write(&notes.join("2026-11-01 09.00 Venue.md"), "# Venue\n\nCall the venue about Thursday.\n");
  write(&notes.join("Projects/Launch.md"), "Launch on Friday.");
  write(&notes.join("Meetings/2026-11-01 10.00 Standup.md"), "**You** 00:00:01 Thursday is fine.");
  write(&home.join("Documents/secret.md"), "outside");
  std::os::unix::fs::symlink(home.join("Documents/secret.md"), notes.join("escape.md")).unwrap();
  let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
  let entry = |at: u64, text: &str| json!({ "atMs": at, "mode": "dictate", "bundleId": "com.apple.mail", "appName": "Mail", "words": 3, "seconds": 1.2, "text": text }).to_string();
  write(&home.join("Library/Application Support/com.tabtasker.dictate/history.jsonl"), &[entry(now - 60_000, "See you Thursday"), "not json".into(), entry(now - 1000, "Thanks a lot")].join("\n"));
  home
}

#[test]
fn an_agent_can_reach_only_what_settings_share() {
  let home = home("shares");
  let mut server = Server::start(&home);

  // Malformed input is answered, and the server keeps going.
  server.line("{ this is not json");
  assert_eq!(server.message()["error"]["code"], -32700);
  server.line("[]");
  assert_eq!(server.message()["error"]["code"], -32600);
  server.line(r#"{ "id": 1, "method": "ping" }"#);
  assert_eq!(server.message()["error"]["code"], -32600);

  let hello = server.ask("initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "claude-code", "version": "2.0" } }));
  assert_eq!(hello["result"]["protocolVersion"], "2025-06-18");
  assert_eq!(hello["result"]["serverInfo"]["name"], "tabtasker-dictate");
  assert_eq!(hello["result"]["capabilities"]["tools"]["listChanged"], true);
  assert_eq!(server.ask("initialize", json!({ "protocolVersion": "2025-03-26" }))["result"]["protocolVersion"], "2025-03-26");
  assert_eq!(server.ask("initialize", json!({ "protocolVersion": "2099-01-01", "clientInfo": { "name": "claude-code" } }))["result"]["protocolVersion"], "2025-06-18");
  server.line(r#"{ "jsonrpc": "2.0", "method": "notifications/initialized" }"#);
  assert_eq!(server.ask("ping", json!({})), json!({ "jsonrpc": "2.0", "id": server.next, "result": {} }));
  assert_eq!(server.ask("resources/list", json!({}))["error"]["code"], -32601);
  assert_eq!(server.ask("tools/call", json!({ "name": "delete_everything" }))["error"]["code"], -32602);
  assert_eq!(server.ask("tools/call", json!({ "name": "read_note", "arguments": "a.md" }))["error"]["code"], -32602);

  // The defaults: notes and meetings, no history, no writing.
  assert_eq!(server.tools(), ["list_notes", "read_note", "search_notes", "list_meetings", "read_meeting"]);
  let listed = server.call("list_notes", json!({})).0["structuredContent"].clone();
  let paths: Vec<&str> = listed["notes"].as_array().unwrap().iter().map(|note| note["path"].as_str().unwrap()).collect();
  assert_eq!(listed["total"], 2);
  assert!(paths.contains(&"2026-11-01 09.00 Venue.md") && paths.contains(&"Projects/Launch.md"), "{paths:?}");
  assert_eq!(server.call("list_notes", json!({ "limit": 1 })).0["structuredContent"]["notes"].as_array().unwrap().len(), 1);
  assert!(server.call("list_notes", json!({ "limit": "all" })).1);
  assert_eq!(server.text("read_note", json!({ "path": "Projects/Launch.md" })), "Launch on Friday.");
  let found = server.call("search_notes", json!({ "query": "THURSDAY" })).0["structuredContent"].clone();
  assert_eq!(found["results"].as_array().unwrap().len(), 1, "a meeting saying Thursday is not a note");
  assert_eq!(found["results"][0]["matches"][0], json!({ "line": 3, "text": "Call the venue about Thursday." }));
  assert!(found["results"][0]["path"].as_str().unwrap().ends_with("Venue.md"));
  assert!(server.call("search_notes", json!({ "query": "  " })).1);
  let meetings = server.call("list_meetings", json!({})).0["structuredContent"].clone();
  assert_eq!(meetings["meetings"][0]["path"], "2026-11-01 10.00 Standup.md");
  assert!(server.text("read_meeting", json!({ "path": "2026-11-01 10.00 Standup.md" })).contains("Thursday is fine"));

  // Nothing outside the folders, through any path.
  for path in ["../secret.md", "escape.md", "/etc/hosts", "Meetings/2026-11-01 10.00 Standup.md", "Projects", ""] {
    let (result, error) = server.call("read_note", json!({ "path": path }));
    assert!(error, "read_note {path:?} got through: {result}");
  }
  for path in ["../2026-11-01 09.00 Venue.md", "../../secret.md"] { assert!(server.call("read_meeting", json!({ "path": path })).1, "{path}"); }
  assert!(server.call("read_note", json!({})).1);

  // Turned off, a tool says how to turn it on.
  let (refused, error) = server.call("recent_dictations", json!({}));
  assert!(error && refused["content"][0]["text"].as_str().unwrap().contains("Recent dictations"));
  assert!(server.call("create_note", json!({ "text": "hi" })).1);

  // A change in Settings reaches the running server, which tells the client its tools changed.
  settings(&home, json!({ "shareNotes": false, "shareHistory": true, "allowWrite": true }));
  let changed = loop { let message = server.message(); if message.get("method").is_some() { break message; } };
  assert_eq!(changed, json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }));
  assert_eq!(server.tools(), ["list_meetings", "read_meeting", "recent_dictations", "create_note", "append_to_note"]);
  assert!(server.call("read_note", json!({ "path": "Projects/Launch.md" })).1);
  let said = server.call("recent_dictations", json!({})).0["structuredContent"]["dictations"].clone();
  assert_eq!(said.as_array().unwrap().iter().map(|entry| entry["text"].as_str().unwrap()).collect::<Vec<_>>(), ["Thanks a lot", "See you Thursday"]);
  assert_eq!(said[0]["app"], "Mail");

  let created = server.call("create_note", json!({ "title": "Ideas: from Claude", "text": "First idea" })).0["structuredContent"].clone();
  let path = created["path"].as_str().unwrap().to_owned();
  assert!(path.ends_with(" Ideas from Claude.md") && !path.contains('/'), "{path}");
  let notes = home.join("Documents/TabTasker Dictate");
  assert!(std::fs::read_to_string(notes.join(&path)).unwrap().contains("First idea"));
  let again = server.call("create_note", json!({ "title": "Ideas: from Claude", "text": "Second" })).0["structuredContent"]["path"].clone();
  assert_ne!(again, json!(path), "a note is never replaced");
  server.text("append_to_note", json!({ "path": path, "text": "Second idea" }));
  let note = std::fs::read_to_string(notes.join(&path)).unwrap();
  assert!(note.contains("First idea") && note.ends_with("\n\nSecond idea\n"), "{note:?}");
  assert!(server.call("append_to_note", json!({ "path": "escape.md", "text": "x" })).1);
  assert!(server.call("append_to_note", json!({ "path": "Meetings/2026-11-01 10.00 Standup.md", "text": "x" })).1);
  assert!(server.call("append_to_note", json!({ "path": "Missing.md", "text": "x" })).1);
  assert_eq!(std::fs::read_to_string(home.join("Documents/secret.md")).unwrap(), "outside");
  assert!(!notes.join("Missing.md").exists());

  // Answer agents off refuses everything.
  settings(&home, json!({ "mcp": false, "allowWrite": true }));
  assert!(server.tools().is_empty());
  let (refused, error) = server.call("list_meetings", json!({}));
  assert!(error && refused["content"][0]["text"].as_str().unwrap().contains("Answer agents"));

  // The Agents page sees the last call.
  let last: Value = serde_json::from_slice(&std::fs::read(home.join("Library/Application Support/com.tabtasker.dictate/agents.json")).unwrap()).unwrap();
  assert_eq!(last["lastCall"]["tool"], "list_meetings");
  assert_eq!(last["lastCall"]["client"], "claude-code");
  assert_eq!(last["lastCall"]["ok"], false);

  // Closing stdin ends the server.
  drop(server.input);
  assert!(server.child.wait().unwrap().success());
  std::fs::remove_dir_all(home).unwrap();
}

#[test]
fn a_folder_that_holds_meetings_or_that_macos_refuses_is_told_apart() {
  use std::os::unix::fs::PermissionsExt;
  let home = home("folders");
  let notes = home.join("Documents/TabTasker Dictate");
  let mut server = Server::start(&home);
  server.ask("initialize", json!({ "protocolVersion": "2025-06-18", "clientInfo": { "name": "cursor-vscode", "title": "Cursor" } }));

  // Meetings saved in the notes folder itself stay with meetings when only notes are shared.
  settings_with(&home, json!({ "agents": { "shareMeetings": false }, "meetings": { "folder": notes } }));
  let (refused, error) = server.call("list_notes", json!({}));
  assert!(error && refused["content"][0]["text"].as_str().unwrap().contains("separate meetings folder"), "{refused}");
  assert!(server.call("read_note", json!({ "path": "Projects/Launch.md" })).1);
  assert!(server.call("search_notes", json!({ "query": "Thursday" })).1);
  settings_with(&home, json!({ "agents": { "shareMeetings": true }, "meetings": { "folder": notes } }));
  assert_eq!(server.call("list_notes", json!({})).0["structuredContent"]["total"], 3);

  // A notes folder macOS won't open says so, instead of looking empty.
  settings(&home, json!({}));
  std::fs::set_permissions(&notes, std::fs::Permissions::from_mode(0o000)).unwrap();
  let listed = server.call("list_notes", json!({}));
  let read = server.call("read_note", json!({ "path": "Projects/Launch.md" }));
  std::fs::set_permissions(&notes, std::fs::Permissions::from_mode(0o755)).unwrap();
  for (result, error) in [listed, read] {
    assert!(error && result["content"][0]["text"].as_str().unwrap().contains("Privacy & Security"), "{result}");
  }

  let last: Value = serde_json::from_slice(&std::fs::read(home.join("Library/Application Support/com.tabtasker.dictate/agents.json")).unwrap()).unwrap();
  assert_eq!(last["lastCall"]["client"], "cursor-vscode");
  assert_eq!(last["lastCall"]["clientTitle"], "Cursor");
  drop(server.input);
  assert!(server.child.wait().unwrap().success());
  std::fs::remove_dir_all(home).unwrap();
}

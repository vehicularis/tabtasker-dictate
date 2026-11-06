fn main() {
  // An agent starts this same binary as its MCP server: no windows, no microphone, no model.
  if std::env::args_os().skip(1).any(|arg| arg == "--mcp") {
    return dictate_lib::ai::mcp::main();
  }
  dictate_lib::run()
}

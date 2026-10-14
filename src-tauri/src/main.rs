// Prevents additional console window on Windows in release, DO NOT REMOVE!!
// (Piped stdio still works, which is all MCP mode needs.)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("mcp") {
        let vault = args.iter().position(|a| a == "--vault").and_then(|i| args.get(i + 1));
        let Some(vault) = vault else {
            eprintln!("usage: fermivault mcp --vault <path>");
            std::process::exit(2);
        };
        let result = fermivault_lib::vault::Vault::new(vault).and_then(fermivault_lib::mcp::serve);
        if let Err(e) = result {
            eprintln!("fermivault mcp: {e}");
            std::process::exit(1);
        }
        return;
    }
    fermivault_lib::run()
}

//! Deliberately minimal initial client. YonedaRepo explores retry strategies above it.
fn main() {
    let args:Vec<String>=std::env::args().skip(1).collect();
    if args.len()!=5 {eprintln!("Usage: retry-client METHOD STATUSES LATENCY_MS BUDGET_MS MAX_ATTEMPTS");std::process::exit(2);}
    let status=args[1].split(',').next().and_then(|s|s.parse::<u16>().ok()).unwrap_or(200);
    let latency=args[2].parse::<u32>().unwrap_or(0);
    println!("{{\"attempts\":1,\"elapsed_ms\":{latency},\"status\":{status}}}");
}

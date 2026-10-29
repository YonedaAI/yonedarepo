//! `yoneda reads add|list|clear`: the reads this session declares for its next push
//! (`$GIT_DIR/yoneda/reads`, sent as `yoneda.reads` push options by `yoneda push`).
use crate::command::ReadsCommand;
use crate::error::{Context, Error, Result};
use crate::session_cmd::{here, relative};
use crate::session_files::SessionFiles;
use crate::{human, output};

pub fn run(command: ReadsCommand) -> Result<()> {
    let cwd = std::env::current_dir().context("current directory")?;
    let at = here(&cwd)?;
    let files = SessionFiles::new(&at.git_dir);
    match command {
        ReadsCommand::Add { paths } => {
            let mut entries = Vec::new();
            for path in &paths {
                entries.push(relative(&at.top, &cwd, path).ok_or_else(|| {
                    Error::usage(format!("{path} is not inside this repository's work tree"))
                })?);
            }
            let added = files.add_reads(&entries)?;
            let total = files.reads()?.len();
            human!("{added} new read(s) declared; {total} in all");
            output::emit(&output::ReadsAdd {
                added: added as u64,
                total: total as u64,
            });
        }
        ReadsCommand::List => {
            let reads = files.reads()?;
            for read in &reads {
                human!("{read}");
            }
            output::emit(&output::ReadsList { reads });
        }
        ReadsCommand::Clear => {
            let cleared = files.reads()?.len();
            files.clear_reads()?;
            human!("Declared reads cleared");
            output::emit(&output::ReadsClear {
                cleared: cleared as u64,
            });
        }
    }
    Ok(())
}

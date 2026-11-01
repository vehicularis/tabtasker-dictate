//! Claude, when the person connects it: polish, commands, summaries and titles. Only text is sent,
//! never audio, and every caller keeps its own words when this answers None.
use crate::context::HoldContext;
use std::ffi::c_char;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind { Meeting, Note }

/// `text` rewritten in the style of the app it is for. Blocking, within 6 s; None keeps the raw text.
pub fn polish(_text: &str, _ctx: &HoldContext) -> Option<String> { None }

/// Markdown: for a meeting the summary, decisions and action items; for a note its action items.
pub fn summarize(_kind: Kind, _text: &str) -> Option<String> { None }

/// A short title for a note or meeting.
pub fn title(_text: &str) -> Option<String> { None }

/// A spoken command from the native side, with the selected text and the app it was said in. True
/// once it is taken: the answer arrives later through `dictate-command` and dictate_command_result.
/// False means Claude is not connected, and the overlay says "Connect Claude in Settings to use commands".
#[no_mangle]
extern "C" fn dictate_command(_request: *const c_char, _instruction: *const c_char, _selection: *const c_char, _bundle_id: *const c_char) -> bool {
  false
}

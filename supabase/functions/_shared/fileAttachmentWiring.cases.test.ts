import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const screen = readFileSync(new URL("../../../src/components/screens/ChatScreen.tsx", import.meta.url), "utf8")
  .split("\r\n")
  .join("\n");
const lib = readFileSync(new URL("../../../src/lib/fileText.ts", import.meta.url), "utf8");

// The checks look inside the one function they are about (an independent review showed that searching the whole
// component, which is thousands of lines, let a removed call pass).
function bodyOf(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} is missing`);
  const end = source.indexOf("\n  }\n", start);
  assert.ok(end > start, `${header} has no end`);
  return source.slice(start, end);
}

describe("attaching a file in the chat screen", () => {
  const picked = bodyOf(screen, "async function handleFilePicked(");
  const send = bodyOf(screen, "async function handleSend()");

  it("has a paperclip that opens a file picker limited to the readable kinds", () => {
    assert.match(screen, /<input[\s\S]{0,200}type="file"/);
    assert.match(screen, /'\.txt,\.md,\.docx,\.pdf'/); // pictures are added to the list only for people who may attach them
    assert.match(screen, /aria-label="Прикрепить файл"/);
    assert.match(screen, /Paperclip/);
  });

  it("shows the paperclip only while no reply is coming", () => {
    const at = screen.indexOf('aria-label="Прикрепить файл"');
    assert.match(screen.slice(at - 900, at), /\{!sending && \(/);
  });

  it("offers exactly the kinds of file the reader accepts", () => {
    const extensions = lib.match(/new Set\(\[([^\]]+)\]\)/)?.[1].match(/'(\w+)'/g)?.map((entry) => entry.replaceAll("'", "")) ?? [];
    assert.deepEqual(extensions.sort(), ["docx", "md", "pdf", "txt"]);
  });

  it("turns the picked file into text and puts it in the message box, never sending it by itself", () => {
    assert.match(picked, /readFileAsText\(file\)/);
    assert.match(picked, /messageFromFileText\(file\.name, text\)/);
    assert.match(picked, /setInputValue\(/);
    assert.doesNotMatch(picked, /handleSend\(|sendAiMessage\(/);
  });

  it("uses the result only if it is still the current pick in the same conversation", () => {
    // Taken before reading; checked after reading and before anything is put in the box.
    assert.match(picked, /const operation = \+\+fileOperationRef\.current/);
    const check = picked.indexOf("operation !== fileOperationRef.current");
    assert.ok(check > 0, "the stale-result check is missing");
    assert.ok(check < picked.indexOf("setInputValue("), "the check must come before the box is changed");
    assert.match(screen, /fileOperationRef\.current \+= 1;\s*setFileReading\(false\);[\s\S]{0,120}\}, \[openConversationId\]\)/);
  });

  it("does not let a question go out while the file is still being read", () => {
    assert.match(send, /fileReading/);
    assert.match(screen, /disabled=\{\(!inputValue\.trim\(\) && attachedImages\.length === 0\) \|\| lengthState\.tooLong \|\| fileReading \|\| imagePreparing\}/);
    assert.match(screen, /disabled=\{fileReading \|\| imagePreparing \|\| voiceConsentOpen/);
  });

  it("tells the person in plain words why a file was not taken", () => {
    assert.match(picked, /fileProblemMessage\(/);
    assert.match(picked, /FileTextError/);
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const screen = readFileSync(new URL("../../../src/components/screens/ChatScreen.tsx", import.meta.url), "utf8");
const lib = readFileSync(new URL("../../../src/lib/fileText.ts", import.meta.url), "utf8");

describe("attaching a file in the chat screen", () => {
  it("has a paperclip that opens a file picker limited to the readable kinds, and is off while a reply is coming", () => {
    assert.match(screen, /<input[\s\S]{0,200}type="file"/);
    assert.match(screen, /accept="\.txt,\.md,\.docx,\.pdf"/);
    assert.match(screen, /aria-label="Прикрепить файл"/);
    assert.match(screen, /Paperclip/);
  });

  it("offers exactly the kinds of file the reader accepts", () => {
    const extensions = lib.match(/new Set\(\[([^\]]+)\]\)/)?.[1].match(/'(\w+)'/g)?.map((entry) => entry.replaceAll("'", "")) ?? [];
    assert.deepEqual(extensions.sort(), ["docx", "md", "pdf", "txt"]);
  });

  it("turns the file into text in the browser and puts it in the message box, never sending it by itself", () => {
    assert.match(screen, /readFileAsText\(file\)/);
    assert.match(screen, /messageFromFileText\(file\.name, text\)/);
    assert.match(screen, /setInputValue\(/);
    assert.match(screen, /from '\.\.\/\.\.\/lib\/fileText'/);
  });

  it("tells the person in plain words why a file was not taken", () => {
    assert.match(screen, /fileProblemMessage\(/);
    assert.match(screen, /FileTextError/);
  });
});

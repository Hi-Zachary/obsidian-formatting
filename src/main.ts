import {Editor, EditorChange, MarkdownView, Notice, Plugin} from "obsidian";

const HEADING_PATTERN = /^(\s{0,3})(#{1,6})(?=\s|$)(.*)$/;
const FENCED_CODE_PATTERN = /^\s*(`{3,}|~{3,})/;
const HORIZONTAL_RULE_PATTERN = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const BLOCKQUOTE_PATTERN = /^\s{0,3}>\s?.*$/;
const TABLE_SEPARATOR_PATTERN = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)?$/;

type HeadingDirection = "promote" | "demote";
type SaveMethod = (this: MarkdownView, clear?: boolean) => Promise<void>;

interface LineRange {
	start: number;
	end: number;
}

interface ProtectedState {
	inFrontmatter: boolean;
	fenceChar: "`" | "~" | null;
	fenceLength: number;
}

interface VisibleLineInfo {
	index: number;
	line: string;
}

export default class HeadingAndSpacingFormatterPlugin extends Plugin {
	private originalSaveMethod: SaveMethod | null = null;
	private saveHookInFlight = new WeakSet<MarkdownView>();

	async onload() {
		this.addCommand({
			id: "promote-selected-headings",
			name: "Promote selected headings",
			hotkeys: [{modifiers: ["Mod", "Alt"], key: "ArrowUp"}],
			editorCallback: (editor) => {
				this.adjustSelectedHeadings(editor, "promote");
			},
		});

		this.addCommand({
			id: "demote-selected-headings",
			name: "Demote selected headings",
			hotkeys: [{modifiers: ["Mod", "Alt"], key: "ArrowDown"}],
			editorCallback: (editor) => {
				this.adjustSelectedHeadings(editor, "demote");
			},
		});

		this.installSaveHook();
	}

	onunload() {
		if (this.originalSaveMethod) {
			MarkdownView.prototype.save = this.originalSaveMethod;
			this.originalSaveMethod = null;
		}
	}

	private installSaveHook(): void {
		if (this.originalSaveMethod) {
			return;
		}

		const plugin = this;
		const originalSave = MarkdownView.prototype.save as SaveMethod;
		this.originalSaveMethod = originalSave;

		MarkdownView.prototype.save = async function (this: MarkdownView, clear?: boolean): Promise<void> {
			if (!plugin.saveHookInFlight.has(this) && this.editor) {
				plugin.saveHookInFlight.add(this);
				try {
					plugin.normalizeEditorSpacing(this.editor);
				} finally {
					plugin.saveHookInFlight.delete(this);
				}
			}

			return originalSave.call(this, clear);
		};
	}

	private adjustSelectedHeadings(editor: Editor, direction: HeadingDirection): void {
		const lineRanges = this.getMergedSelectionLineRanges(editor);
		const lines = this.getEditorLines(editor);
		const protectedLines = this.getProtectedLineSet(lines);
		const changes: EditorChange[] = [];

		for (const range of lineRanges) {
			for (let lineNumber = range.start; lineNumber <= range.end; lineNumber++) {
				if (protectedLines.has(lineNumber)) {
					continue;
				}

				const line = lines[lineNumber] ?? "";
				const match = line.match(HEADING_PATTERN);
				if (!match) {
					continue;
				}

				const indent = match[1] ?? "";
				const hashes = match[2] ?? "";
				const suffix = match[3] ?? "";
				if (direction === "promote" && hashes.length === 1) {
					continue;
				}
				if (direction === "demote" && hashes.length === 6) {
					continue;
				}

				const nextHashes = direction === "promote" ? hashes.slice(0, -1) : `${hashes}#`;
				changes.push({
					from: {line: lineNumber, ch: 0},
					to: {line: lineNumber, ch: line.length},
					text: `${indent}${nextHashes}${suffix}`,
				});
			}
		}

		if (changes.length === 0) {
			new Notice("No headings were updated.");
			return;
		}

		editor.transaction({changes}, "heading-level-adjust");
	}

	private normalizeEditorSpacing(editor: Editor): boolean {
		const original = editor.getValue();
		const formatted = this.normalizeSpacing(original);

		if (formatted === original) {
			return false;
		}

		editor.transaction({
			changes: [
				{
					from: {line: 0, ch: 0},
					to: this.getDocumentEnd(editor),
					text: formatted,
				},
			],
		}, "normalize-spacing");

		return true;
	}

	private normalizeSpacing(content: string): string {
		const lines = content.split("\n");
		const output: string[] = [];
		let state: ProtectedState = {
			inFrontmatter: false,
			fenceChar: null,
			fenceLength: 0,
		};

		for (let index = 0; index < lines.length; index++) {
			const line = lines[index] ?? "";
			const lineState = {...state};
			state = this.advanceProtectedState(line, state, index);

			if (lineState.inFrontmatter || lineState.fenceChar !== null) {
				output.push(line);
				continue;
			}

			if (this.isBlankLine(line)) {
				continue;
			}

			const isHorizontalRule = this.isHorizontalRule(line);
			const isBlockquote = this.isBlockquoteLine(line);
			const isTableStart = this.isTableStart(lines, index, lineState);
			const previousOutputLine = output.length > 0 ? output[output.length - 1] : null;
			const previousContentLine = this.findPreviousContentLine(output);

			if (isHorizontalRule && previousOutputLine !== null && previousOutputLine !== "") {
				output.push("");
			}

			if (
				isBlockquote &&
				previousOutputLine !== null &&
				previousOutputLine !== "" &&
				(previousContentLine === null || !this.isBlockquoteLine(previousContentLine))
			) {
				output.push("");
			}

			if (isTableStart && previousOutputLine !== null && previousOutputLine !== "") {
				output.push("");
			}

			output.push(line);

			const nextVisibleLine = this.findNextVisibleLineInfo(lines, index + 1, state);
			if (isHorizontalRule && nextVisibleLine !== null && output[output.length - 1] !== "") {
				output.push("");
				continue;
			}

			if (isBlockquote && nextVisibleLine !== null && !this.isBlockquoteLine(nextVisibleLine.line) && output[output.length - 1] !== "") {
				output.push("");
			}
		}

		while (output.length > 0 && output[0] === "") {
			output.shift();
		}

		while (output.length > 0 && output[output.length - 1] === "") {
			output.pop();
		}

		return output.join("\n");
	}

	private findPreviousContentLine(lines: string[]): string | null {
		for (let index = lines.length - 1; index >= 0; index--) {
			const line = lines[index];
			if (line !== "") {
				return line ?? null;
			}
		}

		return null;
	}

	private findNextVisibleLineInfo(lines: string[], startIndex: number, initialState: ProtectedState): VisibleLineInfo | null {
		let state = {...initialState};

		for (let index = startIndex; index < lines.length; index++) {
			const line = lines[index] ?? "";
			const lineState = {...state};
			state = this.advanceProtectedState(line, state, index);

			if (lineState.inFrontmatter || lineState.fenceChar !== null) {
				return {index, line};
			}

			if (!this.isBlankLine(line)) {
				return {index, line};
			}
		}

		return null;
	}

	private getMergedSelectionLineRanges(editor: Editor): LineRange[] {
		const ranges = editor.listSelections().map((selection) => {
			const start = Math.min(selection.anchor.line, selection.head.line);
			let end = Math.max(selection.anchor.line, selection.head.line);

			if (
				selection.anchor.line !== selection.head.line &&
				((selection.head.line > selection.anchor.line && selection.head.ch === 0) ||
					(selection.anchor.line > selection.head.line && selection.anchor.ch === 0))
			) {
				end -= 1;
			}

			return {
				start,
				end: Math.max(start, end),
			};
		}).sort((left, right) => left.start - right.start);

		const merged: LineRange[] = [];
		for (const range of ranges) {
			const previous = merged[merged.length - 1];
			if (!previous || range.start > previous.end + 1) {
				merged.push({...range});
				continue;
			}

			previous.end = Math.max(previous.end, range.end);
		}

		return merged;
	}

	private getEditorLines(editor: Editor): string[] {
		const lines: string[] = [];
		for (let index = 0; index < editor.lineCount(); index++) {
			lines.push(editor.getLine(index));
		}
		return lines;
	}

	private getProtectedLineSet(lines: string[]): Set<number> {
		const protectedLines = new Set<number>();
		let state: ProtectedState = {
			inFrontmatter: false,
			fenceChar: null,
			fenceLength: 0,
		};

		for (let index = 0; index < lines.length; index++) {
			const lineState = {...state};
			state = this.advanceProtectedState(lines[index] ?? "", state, index);
			if (lineState.inFrontmatter || lineState.fenceChar !== null || state.inFrontmatter || state.fenceChar !== null) {
				protectedLines.add(index);
			}
		}

		return protectedLines;
	}

	private advanceProtectedState(line: string, state: ProtectedState, lineIndex: number): ProtectedState {
		if (state.inFrontmatter) {
			if (lineIndex > 0 && /^(---|\.\.\.)\s*$/.test(line)) {
				return {
					inFrontmatter: false,
					fenceChar: null,
					fenceLength: 0,
				};
			}

			return state;
		}

		if (state.fenceChar !== null) {
			const closingFence = new RegExp(`^\\s*${state.fenceChar}{${state.fenceLength},}\\s*$`);
			if (closingFence.test(line)) {
				return {
					inFrontmatter: false,
					fenceChar: null,
					fenceLength: 0,
				};
			}

			return state;
		}

		if (lineIndex === 0 && /^---\s*$/.test(line)) {
			return {
				inFrontmatter: true,
				fenceChar: null,
				fenceLength: 0,
			};
		}

		const fenceMatch = line.match(FENCED_CODE_PATTERN);
		if (fenceMatch?.[1]) {
			return {
				inFrontmatter: false,
				fenceChar: fenceMatch[1][0] as "`" | "~",
				fenceLength: fenceMatch[1].length,
			};
		}

		return state;
	}

	private isBlankLine(line: string): boolean {
		return line.trim().length === 0;
	}

	private isHorizontalRule(line: string): boolean {
		return HORIZONTAL_RULE_PATTERN.test(line);
	}

	private isBlockquoteLine(line: string): boolean {
		return BLOCKQUOTE_PATTERN.test(line);
	}

	private isTableStart(lines: string[], index: number, initialState: ProtectedState): boolean {
		const headerLine = lines[index] ?? "";
		const separatorLine = lines[index + 1] ?? "";
		const separatorState = this.advanceProtectedState(headerLine, {...initialState}, index);

		if (!headerLine.includes("|")) {
			return false;
		}

		if (separatorState.inFrontmatter || separatorState.fenceChar !== null) {
			return false;
		}

		return TABLE_SEPARATOR_PATTERN.test(separatorLine);
	}

	private getDocumentEnd(editor: Editor) {
		const lastLine = editor.lastLine();
		return {
			line: lastLine,
			ch: (editor.getLine(lastLine) ?? "").length,
		};
	}
}

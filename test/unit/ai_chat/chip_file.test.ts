import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { THUMBNAIL_MAX_BYTES, chipFile } from "../../../carbon_frappe/public/js/ai_chat/view/attachments.ts";

function file(size: number, type: string, name = "photo.jpg"): File {
	return new File([new Uint8Array(size)], name, { type });
}

describe("chipFile", () => {
	it("keeps a small image typed, so its thumbnail is drawn", () => {
		const small = file(THUMBNAIL_MAX_BYTES, "image/png");
		assert.equal(chipFile(small), small);
	});

	it("hands over a large image without its type", () => {
		const large = file(THUMBNAIL_MAX_BYTES + 1, "image/jpeg");
		const shown = chipFile(large);
		assert.notEqual(shown, large);
		assert.equal(shown.type, "");
		assert.equal(shown.name, large.name);
		assert.equal(shown.size, large.size);
	});

	it("returns the same copy for the same file, so the list sees a stable chip", () => {
		const large = file(THUMBNAIL_MAX_BYTES + 1, "image/jpeg");
		assert.equal(chipFile(large), chipFile(large));
	});

	it("leaves a large file that is not an image alone", () => {
		const pdf = file(THUMBNAIL_MAX_BYTES * 4, "application/pdf", "scan.pdf");
		assert.equal(chipFile(pdf), pdf);
	});
});

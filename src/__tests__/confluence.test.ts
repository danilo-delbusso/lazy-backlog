import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { ConfluenceClient, htmlToMarkdown } from "../lib/confluence.js";

// ── Fetch mock helpers ───────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock>;

function mockFetchResponse(body: unknown, status = 200) {
	fetchMock.mockResolvedValueOnce(
		new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		}),
	);
}

beforeAll(() => {
	fetchMock = mock(() => Promise.resolve(new Response("{}")));
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

afterEach(() => {
	fetchMock.mockClear();
});

const testConfig = {
	siteUrl: "https://test.atlassian.net",
	email: "test@example.com",
	apiToken: "tok_123",
	confluenceSpaces: [],
	rootPageIds: [],
};

// ── htmlToMarkdown ───────────────────────────────────────────────────────────

describe("htmlToMarkdown", () => {
	it("converts headings", () => {
		expect(htmlToMarkdown("<h1>Title</h1>")).toContain("# Title");
		expect(htmlToMarkdown("<h2>Subtitle</h2>")).toContain("## Subtitle");
		expect(htmlToMarkdown("<h3>Section</h3>")).toContain("### Section");
	});

	it("converts bold and italic", () => {
		expect(htmlToMarkdown("<strong>bold</strong>")).toContain("**bold**");
		expect(htmlToMarkdown("<em>italic</em>")).toContain("*italic*");
	});

	it("converts links", () => {
		const html = '<a href="https://example.com">Example</a>';
		expect(htmlToMarkdown(html)).toContain("[Example](https://example.com)");
	});

	it("converts links where text matches href", () => {
		const html = '<a href="https://example.com">https://example.com</a>';
		const md = htmlToMarkdown(html);
		expect(md).not.toContain("[https://example.com]");
	});

	it("converts unordered lists", () => {
		const html = "<ul><li>One</li><li>Two</li></ul>";
		const md = htmlToMarkdown(html);
		expect(md).toContain("- One");
		expect(md).toContain("- Two");
	});

	it("converts code blocks", () => {
		const html = "<pre>const x = 1;</pre>";
		const md = htmlToMarkdown(html);
		expect(md).toContain("```");
		expect(md).toContain("const x = 1;");
	});

	it("converts inline code", () => {
		expect(htmlToMarkdown("Use <code>npm install</code> to install")).toContain("`npm install`");
	});

	it("strips Confluence macros", () => {
		const html = '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter></ac:structured-macro>';
		expect(htmlToMarkdown(html)).toBe("");
	});

	it("strips style and script tags", () => {
		const html = "<style>.x { color: red }</style><script>alert(1)</script><p>Content</p>";
		const md = htmlToMarkdown(html);
		expect(md).not.toContain("color: red");
		expect(md).not.toContain("alert");
		expect(md).toContain("Content");
	});

	it("decodes HTML entities", () => {
		expect(htmlToMarkdown("&amp; &lt; &gt; &quot;")).toBe('& < > "');
	});

	it("converts line breaks", () => {
		expect(htmlToMarkdown("Line one<br/>Line two")).toContain("Line one\nLine two");
	});

	it("converts paragraphs to double newlines", () => {
		const md = htmlToMarkdown("<p>First</p><p>Second</p>");
		expect(md).toContain("First");
		expect(md).toContain("Second");
	});

	it("converts tables to markdown tables", () => {
		const html = "<tr><th>Name</th><th>Value</th></tr><tr><td>Foo</td><td>Bar</td></tr>";
		const md = htmlToMarkdown(html);
		expect(md).toContain("| Name | Value |");
		expect(md).toContain("| --- | --- |");
		expect(md).toContain("| Foo | Bar |");
	});

	it("compacts multiple blank lines", () => {
		const html = "<p>A</p><p></p><p></p><p>B</p>";
		expect(htmlToMarkdown(html)).not.toMatch(/\n{3,}/);
	});

	it("handles empty input", () => {
		expect(htmlToMarkdown("")).toBe("");
	});

	it("strips all remaining HTML tags", () => {
		const html = '<div class="panel"><span>Content</span></div>';
		const md = htmlToMarkdown(html);
		expect(md).not.toContain("<");
		expect(md).toContain("Content");
	});

	it("decodes &nbsp; entities", () => {
		expect(htmlToMarkdown("Hello&nbsp;World")).toContain("Hello World");
	});

	it("decodes &#39; and &#x27; entities", () => {
		expect(htmlToMarkdown("it&#39;s")).toContain("it's");
		expect(htmlToMarkdown("it&#x27;s")).toContain("it's");
	});
});

// ── ConfluenceClient ─────────────────────────────────────────────────────────

describe("ConfluenceClient", () => {
	describe("getSpaces", () => {
		it("fetches and returns spaces", async () => {
			const client = new ConfluenceClient(testConfig);
			mockFetchResponse({
				results: [
					{ id: "1", key: "ENG", name: "Engineering", type: "global" },
					{ id: "2", key: "PM", name: "Product", type: "global" },
				],
				_links: {},
			});

			const spaces = await client.getSpaces();
			expect(spaces).toHaveLength(2);
			expect(spaces[0]!.key).toBe("ENG");
		});
	});

	describe("getSpace", () => {
		it("fetches a single space by key", async () => {
			const client = new ConfluenceClient(testConfig);
			mockFetchResponse({
				results: [{ id: "1", key: "ENG", name: "Engineering", type: "global" }],
				_links: {},
			});

			const space = await client.getSpace("ENG");
			expect(space).toBeDefined();
			expect(space!.key).toBe("ENG");
		});

		it("returns undefined for nonexistent space", async () => {
			const client = new ConfluenceClient(testConfig);
			mockFetchResponse({ results: [], _links: {} });

			const space = await client.getSpace("NOPE");
			expect(space).toBeUndefined();
		});
	});

	describe("getPageFull", () => {
		it("fetches page with labels", async () => {
			const client = new ConfluenceClient(testConfig);
			// First response: page data
			mockFetchResponse({
				id: "123",
				title: "Design Doc",
				spaceId: "space-1",
				status: "current",
				authorId: "user-1",
				createdAt: "2025-01-01",
				version: { createdAt: "2025-06-01" },
				body: { storage: { value: "<p>Hello</p>" } },
				_links: { webui: "/spaces/ENG/pages/123" },
			});
			// Second response: labels
			mockFetchResponse({
				results: [{ name: "design-doc" }, { name: "auth" }],
				_links: {},
			});

			const page = await client.getPageFull("123");
			expect(page.id).toBe("123");
			expect(page.title).toBe("Design Doc");
			expect(page.labels).toEqual(["design-doc", "auth"]);
			expect(page.body).toContain("Hello");
			expect(page.url).toContain("/spaces/ENG/pages/123");
		});
	});

	describe("getPageChildren", () => {
		it("fetches child pages", async () => {
			const client = new ConfluenceClient(testConfig);
			mockFetchResponse({
				results: [
					{ id: "child-1", title: "Child 1", spaceId: "s1", status: "current" },
					{ id: "child-2", title: "Child 2", spaceId: "s1", status: "current" },
				],
				_links: {},
			});

			const children = await client.getPageChildren("parent-1");
			expect(children).toHaveLength(2);
			expect(children[0]!.id).toBe("child-1");
		});
	});

	describe("listPagesInSpace", () => {
		it("fetches all pages in a space", async () => {
			const client = new ConfluenceClient(testConfig);
			mockFetchResponse({
				results: [
					{ id: "p1", title: "Page 1", spaceId: "s1", status: "current" },
				],
				_links: {},
			});

			const pages = await client.listPagesInSpace("space-1");
			expect(pages).toHaveLength(1);
			expect(pages[0]!.title).toBe("Page 1");
		});
	});

	describe("searchCQL", () => {
		it("searches with CQL and returns mapped pages", async () => {
			const client = new ConfluenceClient(testConfig);
			mockFetchResponse({
				results: [
					{
						content: {
							id: "p1",
							title: "Auth Design",
							spaceId: "s1",
							status: "current",
							_links: {},
						},
					},
				],
				_links: {},
			});

			const results = await client.searchCQL('text ~ "auth"');
			expect(results).toHaveLength(1);
			expect(results[0]!.title).toBe("Auth Design");
		});
	});

	describe("request error handling", () => {
		it("throws on 4xx errors", async () => {
			const client = new ConfluenceClient(testConfig);
			fetchMock.mockResolvedValueOnce(
				new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } }),
			);

			await expect(client.getSpaces()).rejects.toThrow("Confluence API 404");
		});
	});
});

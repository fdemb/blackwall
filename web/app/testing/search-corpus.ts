/** One issue's text and a search typed against it. Each case is checked against PostgreSQL. */
export interface SearchCase {
  title: string;
  description: string;
  search: string;
}

const c = (title: string, search: string, description = ""): SearchCase => ({
  title,
  description,
  search,
});

// Hand-picked strings that exercise PostgreSQL's default parser for the simple configuration.
export const SEARCH_CORPUS: readonly SearchCase[] = [
  // Accented and non-Latin letters
  c("naïve—test foo😀bar", "test naïve"),
  c("naïve—test foo😀bar", "bar foo"),
  c("Café au lait", "cafe"),
  c("Café au lait", "café"),
  c("Crème brûlée", "brûlée crème"),
  c("Ünal and Unal", "ünal"),
  c("Ørsted power", "ørsted"),
  c("Straße map", "strasse"),
  c("Straße map", "straße"),
  c("ŁÓDŹ office", "łódź"),
  c("Αθήνα αρχείο", "αθήνα"),
  c("Привет мир", "мир привет"),
  c("שלום עולם", "עולם"),
  c("مرحبا بالعالم", "بالعالم"),
  c("สวัสดีครับ ทุกคน", "ทุกคน"),
  c("नमस्ते दुनिया", "दुनिया"),
  c("안녕하세요 세계", "세계"),
  c("中文 测试", "测试"),
  c("日本語のテスト", "テスト"),
  c("カタカナ and ひらがな", "ひらがな"),
  c("étude facile", "étude"),
  c("zoë test", "zoë"),
  c("Ἀθῆναι", "ἀθῆναι"),

  // Dashes, apostrophes, and separators
  c("state-of-the-art design", "state of the art"),
  c("state-of-the-art design", "state-of-the-art"),
  c("state-of-the-art design", "the-art"),
  c("red – blue", "red blue"),
  c("red—blue", "red blue"),
  c("don't stop", "don't"),
  c("don't stop", "dont stop"),
  c("it’s curly", "it’s"),
  c("it’s curly", "it s curly"),
  c("'quoted' words", "quoted"),
  c("«guillemets» and „quotes“", "guillemets quotes"),
  c("wait…for it", "wait for"),
  c("non breaking space", "breaking space"),
  c("tab\tseparated", "tab separated"),

  // Emoji and symbols between letters
  c("foo😀bar", "foo bar"),
  c("foo😀bar", "foobar"),
  c("foo😀bar", "😀"),
  c("launch 🚀now", "now launch"),
  c("price €10 or $5", "10 5"),
  c("price €10 or $5", "€10"),
  c("ratio 100% sure", "100%"),
  c("ratio 100% sure", "100% sure"),
  c("a+b=c", "a b c"),
  c("C++ and C# code", "c code"),
  c("tag #release here", "release"),
  c("ping @alice now", "alice"),

  // Digits mixed with letters and numbers
  c("abc123 xyz", "abc123"),
  c("abc123 xyz", "abc"),
  c("123abc item", "123abc"),
  c("v2beta release", "v2beta"),
  c("v2beta release", "v2"),
  c("Install 1.2.3 now", "1.2.3"),
  c("Install 1.2.3 now", "3 2"),
  c("pi is 3.14", "3.14"),
  c("pi is 3.14", "3 14"),
  c("value 3.14e+10 end", "3.14e+10"),
  c("temperature -42 degrees", "-42"),
  c("temperature -42 degrees", "42"),
  c("count ٣٤ items", "٣٤"),
  c("roman Ⅻ numeral", "Ⅻ"),
  c("superscript x² value", "x2"),

  // Underscores, identifiers, and wildcards
  c("foo_bar baz", "foo_bar"),
  c("foo_bar baz", "bar foo"),
  c("snake_case_name", "case"),
  c("100% done", "%"),
  c("a_b", "_"),
  c("path \\ here", "\\"),
  c("path \\ here", "\\ h"),

  // URLs, emails, paths, markup, and entities
  c("see https://example.com/path?x=1 today", "example.com"),
  c("see https://example.com/path?x=1 today", "path x 1"),
  c("see https://example.com/path?x=1 today", "https"),
  c("write user@example.com here", "user"),
  c("write user@example.com here", "user example"),
  c("write user@example.com here", "user@example.com"),
  c("naïve@example.com contact", "naïve"),
  c("<b>bold</b> text", "b bold"),
  c("&amp; ampersand", "amp"),
  c("fish &amp; chips", "fish chips"),
  c("file /usr/local/bin here", "/usr/local/bin"),
  c("file /usr/local/bin here", "local"),

  // Case variants
  c("ÉCOLE Normale", "école"),
  c("İstanbul", "istanbul"),
  c("ISTANBUL", "istanbul"),
  c("MiXeD CaSe", "mixed case"),
  c("MiXeD CaSe", "MIXED"),

  // Empty, whitespace-only, and surrounding spaces
  c("anything", ""),
  c("anything", " \t "),
  c("anything", "  test  "),
  c("test in title", " title "),
  c("", "anything"),
  c("", ""),
  c("tail punctuation!", "punctuation!"),
  c("half—dash", "half"),
  c("word", "—"),
  c("—", "—"),
  c("cut", "cu"),
];

// Cases behind the default-run expectations in issue-search.test.ts. Each answer is the local rule's.
export const KEY_CASES: readonly [SearchCase, boolean][] = [
  [c("naïve—test foo😀bar", "test naïve"), true],
  [c("naïve—test foo😀bar", "bar foo"), true],
  [c("naïve—test foo😀bar", "naïve-test"), true],
  [c("foo😀bar", "foo bar"), true],
  [c("Café au lait", "cafe"), false],
  [c("state-of-the-art design", "state of the art"), true],
  [c("state-of-the-art design", "the-art"), true],
  [c("don't stop", "dont stop"), false],
  [c("Install 1.2.3 now", "1.2.3"), true],
  [c("Install 1.2.3 now", "3 2"), true],
  [c("snake_case_name", "case"), true],
  [c("foo_bar baz", "bar foo"), true],
  [c("see https://example.com/path?x=1 today", "example.com"), true],
  [c("ÉCOLE Normale", "école"), true],
  [c("İstanbul", "istanbul"), false],
  [c("anything", " \t "), true],
  [c("tag_1.2.3", "1.2.3"), true],
  [c("v1.2.3-beta release", "v1.2.3-beta"), true],
  [c("x.y_Ⅻ", "x.y_"), true],
];

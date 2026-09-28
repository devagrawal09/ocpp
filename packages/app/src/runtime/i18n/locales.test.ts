import { describe, expect, test } from "bun:test"
import { LOCALE_LABELS, LOCALE_TAGS, LOCALES, matchLocale } from "./locales"

describe("locale labels", () => {
  test("uses native language names independent of the active locale", () => {
    expect(LOCALES.map((locale) => LOCALE_LABELS[locale])).toEqual([
      "English",
      "简体中文",
      "繁體中文",
      "한국어",
      "Deutsch",
      "Español",
      "Français",
      "Dansk",
      "日本語",
      "Polski",
      "Русский",
      "Українська",
      "Bosanski",
      "العربية",
      "עברית",
      "Norsk",
      "Português (Brasil)",
      "ไทย",
      "Türkçe",
      "हिन्दी",
      "Nederlands",
      "Bahasa Indonesia",
      "Tiếng Việt",
      "Italiano",
      "اردو",
      "پنجابی",
      "Azərbaycanca",
      "Suomi",
      "Svenska",
      "አማርኛ",
      "Български",
      "বাংলা",
      "Català",
      "Čeština",
      "ދިވެހި",
      "རྫོང་ཁ",
      "Ελληνικά",
      "Eesti",
      "فارسی",
      "Føroyskt",
      "Hrvatski",
      "Magyar",
      "Հայերեն",
      "Íslenska",
      "ქართული",
      "ខ្មែរ",
      "ລາວ",
      "Lietuvių",
      "Latviešu",
      "Македонски",
      "Монгол",
      "Bahasa Melayu",
      "မြန်မာ",
      "नेपाली",
      "Română",
      "සිංහල",
      "Slovenčina",
      "Slovenščina",
      "Shqip",
      "Српски",
      "Тоҷикӣ",
      "Türkmençe",
      "Oʻzbekcha",
    ])
  })
})

describe("locale detection", () => {
  test("follows preference order and skips invalid or unsupported tags", () => {
    expect(matchLocale(["not_a_locale", "fr-FR"])).toBe("fr")
    expect(matchLocale(["eo", "de-DE"])).toBe("de")
  })

  test("uses Unicode likely subtags for script-sensitive bundles", () => {
    expect(matchLocale(["zh-TW"])).toBe("zht")
    expect(matchLocale(["zh-SG"])).toBe("zh")
    expect(matchLocale(["pa-PK"])).toBe("pa")
    expect(matchLocale(["pa-IN", "fr"])).toBe("fr")
    expect(matchLocale(["az-Cyrl", "de"])).toBe("de")
    expect(matchLocale(["sr-Cyrl"])).toBe("sr")
    expect(matchLocale(["sr-Latn", "en"])).toBe("en")
    expect(matchLocale(["uz-Latn"])).toBe("uz")
  })

  test("recognizes Norwegian language tags", () => {
    expect(matchLocale(["no"])).toBe("no")
    expect(matchLocale(["nb-NO"])).toBe("no")
    expect(matchLocale(["nn-NO"])).toBe("no")
  })

  test("recognizes Hebrew language tags", () => {
    expect(matchLocale(["he"])).toBe("he")
    expect(matchLocale(["he-IL"])).toBe("he")
  })
})

describe("locale ICU data", () => {
  test("accepts every locale in standard Intl formatters", () => {
    for (const locale of LOCALES) {
      const tag = LOCALE_TAGS[locale]
      expect(() => new Intl.Locale(tag), `${locale} locale`).not.toThrow()
      expect(() => new Intl.NumberFormat(tag), `${locale} number`).not.toThrow()
      expect(() => new Intl.DateTimeFormat(tag), `${locale} date`).not.toThrow()
      expect(() => new Intl.PluralRules(tag), `${locale} plural`).not.toThrow()
      expect(() => new Intl.ListFormat(tag), `${locale} list`).not.toThrow()
      expect(() => new Intl.DisplayNames(tag, { type: "language" }), `${locale} names`).not.toThrow()
      expect(() => new Intl.Segmenter(tag), `${locale} segmenter`).not.toThrow()
    }
  })
})

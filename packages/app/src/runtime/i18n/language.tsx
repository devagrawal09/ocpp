import { flatten, resolveTemplate, translator, type Flatten } from "@solid-primitives/i18n"
import { createEffect, createMemo, createResource, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@ocpp/ui/context"
import {
  I18nProvider,
  type UiI18n,
  pluralCategory,
  type UiI18nPluralLookupKey,
  type UiI18nPluralKey,
  type UiPluralCategory,
} from "@ocpp/ui/context/i18n"
import { Persist, persisted } from "@/runtime/persistence/storage"
import en from "@/runtime/i18n/en"
import { dict } from "@ocpp/ui/i18n/en"
import { LOCALE_LABELS, LOCALE_TAGS, LOCALES, matchLocale, type Locale } from "@/runtime/i18n/locales"

export type { Locale }
export type Direction = "ltr" | "rtl"

const RTL_LOCALES: ReadonlySet<Locale> = new Set(["ar", "he", "ur", "pa", "fa", "dv"])

function localeDirection(locale: Locale): Direction {
  return RTL_LOCALES.has(locale) ? "rtl" : "ltr"
}

type RawDictionary = typeof en & typeof dict
type Dictionary = Flatten<RawDictionary>
type AppI18nKey = Extract<keyof typeof en, string>
type AppI18nPluralKey = {
  [Key in AppI18nKey]: Key extends `${infer Base}.other` ? (`${Base}.one` extends AppI18nKey ? Base : never) : never
}[AppI18nKey]
type PluralKey = AppI18nPluralKey | UiI18nPluralKey
type AppI18nPluralLookupKey = `${AppI18nPluralKey}.${UiPluralCategory}`
type TranslationKey<Key extends Extract<keyof Dictionary, string>> = Key extends
  | AppI18nPluralLookupKey
  | UiI18nPluralLookupKey
  ? never
  : Key
type Source = { dict: Record<string, string> }

function cookie(locale: Locale) {
  return `oc_locale=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`
}

const base = flatten({ ...en, ...dict })
const dicts = new Map<Locale, Dictionary>([["en", base]])

const merge = (app: Promise<Source>, ui: Promise<Source>) =>
  Promise.all([app, ui]).then(([a, b]) => ({ ...base, ...flatten({ ...a.dict, ...b.dict }) }) as Dictionary)

const loaders: Record<Exclude<Locale, "en">, () => Promise<Dictionary>> = {
  zh: () => merge(import("@/runtime/i18n/zh"), import("@ocpp/ui/i18n/zh")),
  zht: () => merge(import("@/runtime/i18n/zht"), import("@ocpp/ui/i18n/zht")),
  ko: () => merge(import("@/runtime/i18n/ko"), import("@ocpp/ui/i18n/ko")),
  de: () => merge(import("@/runtime/i18n/de"), import("@ocpp/ui/i18n/de")),
  es: () => merge(import("@/runtime/i18n/es"), import("@ocpp/ui/i18n/es")),
  fr: () => merge(import("@/runtime/i18n/fr"), import("@ocpp/ui/i18n/fr")),
  da: () => merge(import("@/runtime/i18n/da"), import("@ocpp/ui/i18n/da")),
  ja: () => merge(import("@/runtime/i18n/ja"), import("@ocpp/ui/i18n/ja")),
  pl: () => merge(import("@/runtime/i18n/pl"), import("@ocpp/ui/i18n/pl")),
  ru: () => merge(import("@/runtime/i18n/ru"), import("@ocpp/ui/i18n/ru")),
  uk: () => merge(import("@/runtime/i18n/uk"), import("@ocpp/ui/i18n/uk")),
  ar: () => merge(import("@/runtime/i18n/ar"), import("@ocpp/ui/i18n/ar")),
  he: () => merge(import("@/runtime/i18n/he"), import("@ocpp/ui/i18n/he")),
  no: () => merge(import("@/runtime/i18n/no"), import("@ocpp/ui/i18n/no")),
  br: () => merge(import("@/runtime/i18n/br"), import("@ocpp/ui/i18n/br")),
  th: () => merge(import("@/runtime/i18n/th"), import("@ocpp/ui/i18n/th")),
  bs: () => merge(import("@/runtime/i18n/bs"), import("@ocpp/ui/i18n/bs")),
  tr: () => merge(import("@/runtime/i18n/tr"), import("@ocpp/ui/i18n/tr")),
  hi: () => merge(import("@/runtime/i18n/hi"), import("@ocpp/ui/i18n/hi")),
  nl: () => merge(import("@/runtime/i18n/nl"), import("@ocpp/ui/i18n/nl")),
  id: () => merge(import("@/runtime/i18n/id"), import("@ocpp/ui/i18n/id")),
  vi: () => merge(import("@/runtime/i18n/vi"), import("@ocpp/ui/i18n/vi")),
  it: () => merge(import("@/runtime/i18n/it"), import("@ocpp/ui/i18n/it")),
  ur: () => merge(import("@/runtime/i18n/ur"), import("@ocpp/ui/i18n/ur")),
  pa: () => merge(import("@/runtime/i18n/pa"), import("@ocpp/ui/i18n/pa")),
  az: () => merge(import("@/runtime/i18n/az"), import("@ocpp/ui/i18n/az")),
  fi: () => merge(import("@/runtime/i18n/fi"), import("@ocpp/ui/i18n/fi")),
  sv: () => merge(import("@/runtime/i18n/sv"), import("@ocpp/ui/i18n/sv")),
  am: () => merge(import("@/runtime/i18n/am"), import("@ocpp/ui/i18n/am")),
  bg: () => merge(import("@/runtime/i18n/bg"), import("@ocpp/ui/i18n/bg")),
  bn: () => merge(import("@/runtime/i18n/bn"), import("@ocpp/ui/i18n/bn")),
  ca: () => merge(import("@/runtime/i18n/ca"), import("@ocpp/ui/i18n/ca")),
  cs: () => merge(import("@/runtime/i18n/cs"), import("@ocpp/ui/i18n/cs")),
  dv: () => merge(import("@/runtime/i18n/dv"), import("@ocpp/ui/i18n/dv")),
  dz: () => merge(import("@/runtime/i18n/dz"), import("@ocpp/ui/i18n/dz")),
  el: () => merge(import("@/runtime/i18n/el"), import("@ocpp/ui/i18n/el")),
  et: () => merge(import("@/runtime/i18n/et"), import("@ocpp/ui/i18n/et")),
  fa: () => merge(import("@/runtime/i18n/fa"), import("@ocpp/ui/i18n/fa")),
  fo: () => merge(import("@/runtime/i18n/fo"), import("@ocpp/ui/i18n/fo")),
  hr: () => merge(import("@/runtime/i18n/hr"), import("@ocpp/ui/i18n/hr")),
  hu: () => merge(import("@/runtime/i18n/hu"), import("@ocpp/ui/i18n/hu")),
  hy: () => merge(import("@/runtime/i18n/hy"), import("@ocpp/ui/i18n/hy")),
  is: () => merge(import("@/runtime/i18n/is"), import("@ocpp/ui/i18n/is")),
  ka: () => merge(import("@/runtime/i18n/ka"), import("@ocpp/ui/i18n/ka")),
  km: () => merge(import("@/runtime/i18n/km"), import("@ocpp/ui/i18n/km")),
  lo: () => merge(import("@/runtime/i18n/lo"), import("@ocpp/ui/i18n/lo")),
  lt: () => merge(import("@/runtime/i18n/lt"), import("@ocpp/ui/i18n/lt")),
  lv: () => merge(import("@/runtime/i18n/lv"), import("@ocpp/ui/i18n/lv")),
  mk: () => merge(import("@/runtime/i18n/mk"), import("@ocpp/ui/i18n/mk")),
  mn: () => merge(import("@/runtime/i18n/mn"), import("@ocpp/ui/i18n/mn")),
  ms: () => merge(import("@/runtime/i18n/ms"), import("@ocpp/ui/i18n/ms")),
  my: () => merge(import("@/runtime/i18n/my"), import("@ocpp/ui/i18n/my")),
  ne: () => merge(import("@/runtime/i18n/ne"), import("@ocpp/ui/i18n/ne")),
  ro: () => merge(import("@/runtime/i18n/ro"), import("@ocpp/ui/i18n/ro")),
  si: () => merge(import("@/runtime/i18n/si"), import("@ocpp/ui/i18n/si")),
  sk: () => merge(import("@/runtime/i18n/sk"), import("@ocpp/ui/i18n/sk")),
  sl: () => merge(import("@/runtime/i18n/sl"), import("@ocpp/ui/i18n/sl")),
  sq: () => merge(import("@/runtime/i18n/sq"), import("@ocpp/ui/i18n/sq")),
  sr: () => merge(import("@/runtime/i18n/sr"), import("@ocpp/ui/i18n/sr")),
  tg: () => merge(import("@/runtime/i18n/tg"), import("@ocpp/ui/i18n/tg")),
  tk: () => merge(import("@/runtime/i18n/tk"), import("@ocpp/ui/i18n/tk")),
  uz: () => merge(import("@/runtime/i18n/uz"), import("@ocpp/ui/i18n/uz")),
}

function loadDict(locale: Locale) {
  const hit = dicts.get(locale)
  if (hit) return Promise.resolve(hit)
  if (locale === "en") return Promise.resolve(base)
  const load = loaders[locale]
  return load().then((next: Dictionary) => {
    dicts.set(locale, next)
    return next
  })
}

export function loadLocaleDict(locale: Locale) {
  return loadDict(locale).then(() => undefined)
}

function detectLocale(): Locale {
  if (typeof navigator !== "object") return "en"
  return matchLocale(navigator.languages?.length ? navigator.languages : [navigator.language])
}

export function normalizeLocale(value: string): Locale {
  return LOCALES.includes(value as Locale) ? (value as Locale) : "en"
}

function readStoredLocale() {
  if (typeof localStorage !== "object") return
  try {
    const raw = localStorage.getItem("ocpp.global.dat:language")
    if (!raw) return
    const next = JSON.parse(raw) as { locale?: string }
    if (typeof next?.locale !== "string") return
    return normalizeLocale(next.locale)
  } catch {
    return
  }
}

const warm = readStoredLocale() ?? detectLocale()
const initialLocale =
  warm === "en"
    ? Promise.resolve(warm)
    : loadDict(warm).then(
        () => warm,
        () => "en" as const,
      )

export function loadInitialLocale() {
  return initialLocale
}

export const { use: useLanguage, provider: LanguageProvider } = createSimpleContext({
  name: "Language",
  gate: false,
  init: (props: { locale?: Locale }) => {
    const initial = props.locale ?? readStoredLocale() ?? detectLocale()
    const [store, setStore, _, ready] = persisted(
      Persist.global("language"),
      createStore({
        locale: initial,
      }),
    )

    const locale = createMemo<Locale>(() => normalizeLocale(store.locale))
    const intl = createMemo(() => LOCALE_TAGS[locale()])
    const [layout, setLayout] = createStore({ direction: undefined as Direction | undefined })
    const direction = createMemo(() => layout.direction ?? localeDirection(locale()))
    const layoutLocale = createMemo(() => {
      if (!layout.direction) return intl()
      // Kobalte derives menu direction from locale rather than accepting a direction override.
      return layout.direction === "rtl" ? "ar" : "en"
    })

    const [dictionary] = createResource(locale, loadDict, {
      initialValue: dicts.get(initial) ?? base,
    })

    const t = translator(() => dictionary() ?? base, resolveTemplate) as <
      Key extends Extract<keyof Dictionary, string>,
    >(
      key: TranslationKey<Key>,
      params?: Record<string, string | number | boolean>,
    ) => string

    const pluralForm = (
      key: PluralKey,
      category: UiPluralCategory,
      params?: Record<string, string | number | boolean>,
    ) => {
      const current = (dictionary.loading ? base : (dictionary() ?? base)) as Record<string, string>
      const candidate = `${key}.${category}`
      const fallback = `${key}.other`
      return resolveTemplate(current[candidate] ?? current[fallback] ?? fallback, params)
    }
    const plural = (key: PluralKey, count: number, params?: Record<string, string | number | boolean>) =>
      pluralForm(key, pluralCategory(intl(), count), { ...params, count })

    const label = (value: Locale) => LOCALE_LABELS[value]

    createEffect(() => {
      if (typeof document !== "object") return
      const value = locale()
      document.documentElement.lang = intl()
      document.documentElement.dir = direction()
      document.cookie = cookie(value)
    })

    return {
      ready,
      locale,
      intl,
      direction,
      layoutLocale,
      locales: LOCALES,
      label,
      t,
      plural,
      pluralForm,
      setLocale(next: Locale) {
        setStore("locale", normalizeLocale(next))
      },
      setDirection(next: Direction) {
        setLayout("direction", next === localeDirection(locale()) ? undefined : next)
      },
    }
  },
})

export function UiI18nBridge(props: { children?: JSX.Element }) {
  const language = useLanguage()
  return (
    <I18nProvider
      value={{
        locale: language.intl,
        layoutLocale: language.layoutLocale,
        t: language.t as UiI18n["t"],
        plural: language.plural,
        pluralForm: language.pluralForm,
      }}
    >
      {props.children}
    </I18nProvider>
  )
}

declare module "virtual:vite-ocpp-picker/client"

interface ImportMetaEnv {
  readonly OCPP_CHANNEL: string
  readonly OCPP_VERSION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

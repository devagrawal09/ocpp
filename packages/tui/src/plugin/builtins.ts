import HomeFooter from "../feature-plugins/home/footer"
import PromptFooter from "../feature-plugins/prompt/footer"
import SidebarContext from "../feature-plugins/sidebar/context"
import SidebarFooter from "../feature-plugins/sidebar/footer"
import SidebarMcp from "../feature-plugins/sidebar/mcp"
import DiffViewer from "../feature-plugins/system/diff-viewer"
import Notifications from "../feature-plugins/system/notifications"
import Plugins from "../feature-plugins/system/plugins"
import Storybook from "../feature-plugins/system/storybook"
import Latex from "@ocpp/latex/plugin"
import Merman from "@ocpp/merman/plugin"

export const builtins = [
  HomeFooter,
  PromptFooter,
  SidebarContext,
  SidebarMcp,
  SidebarFooter,
  Notifications,
  Plugins,
  Merman,
  Latex,
  // The storybook is a development tool; keep its route and palette commands out of
  // normal launches and register it only for OCPP_STORY runs.
  ...(process.env.OCPP_STORY ? [Storybook] : []),
  DiffViewer,
]

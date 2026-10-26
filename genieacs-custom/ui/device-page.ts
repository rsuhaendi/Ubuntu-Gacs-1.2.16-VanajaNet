import { ClosureComponent, Component } from "mithril";
import { m } from "./components.ts";
import config from "./config.ts";
import * as store from "./store.ts";

export function init(
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!window.authorizer.hasAccess("devices", 2)) {
    return Promise.reject(
      new Error("You are not authorized to view this page")
    );
  }

  // Tangkap seluruh string ID secara utuh dari hash URL browser 
  // agar tidak terpotong oleh router pada tanda hubung (khusus perangkat HSGQ/panjang)
  let deviceId = "";
  const hash = window.location.hash;
  const match = hash.match(/\/devices\/([^/]+)/);
  if (match && match[1]) {
    deviceId = decodeURIComponent(match[1]);
  } else {
    deviceId = typeof args.id === "string" ? decodeURIComponent(args.id) : "";
  }

  return Promise.resolve({
    deviceId: deviceId,
    deviceFilter: ["=", ["PARAM", "DeviceID.ID"], deviceId],
    tab: args.tab,
  });
}

export const component: ClosureComponent = (): Component => {
  return {
    view: (vnode) => {
      document.title = `${vnode.attrs["deviceId"]}Device - GenieACS`;

      const dev = store.fetch("devices", vnode.attrs["deviceFilter"]);
      if (!dev.value.length) {
        if (!dev.fulfilling)
          return m("p.error", `No such device ${vnode.attrs["deviceId"]}`);
        return m(
          "loading",
          { queries: [dev] },
          m("div", { style: "height: 100px;" })
        );
      }

      const conf = config.ui.device;
      const deviceTabs = config.ui.deviceTabs;
      
      const cmps = [];

      // ==========================================
      // 1. RENDER CONFIG 1 (Selalu dipanggil di atas)
      // ==========================================
      if (conf && Object.keys(conf).length > 0) {
        for (const c of Object.values(conf)) {
          cmps.push(
            m.context(
              { device: dev.value[0], deviceQuery: dev },
              store.evaluateExpression(c["type"], null) as string,
              c
            )
          );
        }  
      }

      // ==========================================
      // 2. RENDER TABS ATAU KOMPONEN TAMBAHAN
      // ==========================================
      if (deviceTabs && Object.keys(deviceTabs).length > 0) {
        const defaultRoute = Object.values(deviceTabs)[0]["route"];
        const currentTab = (vnode.attrs["tab"] as string) || defaultRoute;
        const tabActive = { [currentTab]: "active" };
        
        const tabs = [];
        const tabContent = [];

        for (const [k, c] of Object.entries(deviceTabs)) {
          tabs.push(
            m("li", {
              "class": tabActive[c["route"]],
            }, [
              m("a", {
                // Gunakan encodeURIComponent pada ID agar aman dari pemotongan router saat pindah tab
                href: `#!/devices/${encodeURIComponent(vnode.attrs["deviceId"] as string)}/${c["route"]}`,
              }, c["label"])
            ])
          );

          if (tabActive[c["route"]]) {
            for (const comp of Object.values(c["components"])) {
              tabContent.push(
                m.context(
                  { device: dev.value[0], deviceQuery: dev },
                  store.evaluateExpression(comp["type"], null) as string,
                  comp,
                )
              );  
            }  
          }
        }

        cmps.push(
          m("div.tab", [
            m("ul", tabs),
            m("div.tab_content", tabContent)
          ])
        );
      }

      return [m("h1", vnode.attrs["deviceId"]), cmps];
    },
  };
};

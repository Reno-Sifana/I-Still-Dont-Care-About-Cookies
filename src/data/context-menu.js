// Vars

let cachedRules = {};
let whitelistedDomains = {};
let tabList = {};
const xmlTabs = {};
let lastDeclarativeNetRuleId = 1;

const isManifestV3 = chrome.runtime.getManifest().manifest_version == 3;

if (isManifestV3) {
  /* rules.js */
  try {
    importScripts("rules.js");
  } catch (e) {
    console.log(e);
  }
}

// Common functions

function getHostname(url, cleanup) {
  try {
    if (url.indexOf("http") != 0) {
      throw true;
    }

    const a = new URL(url);

    return typeof cleanup == "undefined"
      ? a.hostname
      : a.hostname.replace(/^w{2,3}\d*\./i, "");
  } catch (error) {
    return false;
  }
}

// Whitelisting
function updateWhitelist() {
  lastDeclarativeNetRuleId = 1;
  chrome.storage.local.get("whitelisted_domains", async (storedWhitelist) => {
    if (typeof storedWhitelist.whitelisted_domains != "undefined") {
      whitelistedDomains = storedWhitelist.whitelisted_domains;
    }

    if (isManifestV3) {
      await UpdateWhitelistRules();
    }
  });
}

async function UpdateWhitelistRules() {
  if (!isManifestV3) {
    console.warn("Called unsupported function");
    return;
  }
  const previousRules = (
    await chrome.declarativeNetRequest.getDynamicRules()
  ).map((v) => {
    return v.id;
  });
  const addRules = Object.entries(whitelistedDomains)
    .filter((element) => element[1])
    .map((v) => {
      return {
        id: lastDeclarativeNetRuleId++,
        priority: 1,
        action: { type: "allow" },
        condition: {
          urlFilter: "*",
          resourceTypes: ["script", "stylesheet", "xmlhttprequest", "image"],
          initiatorDomains: [v[0]],
        },
      };
    });

  chrome.declarativeNetRequest.updateDynamicRules({
    addRules,
    removeRuleIds: previousRules,
  });
}

updateWhitelist();

chrome.runtime.onMessage.addListener(async function (request, info) {
  if (request == "update_whitelist") {
    updateWhitelist();
  }
});

function isWhitelisted(tab) {
  if (typeof whitelistedDomains[tab.hostname] != "undefined") {
    return true;
  }

  for (const i in tab.host_levels) {
    if (typeof whitelistedDomains[tab.host_levels[i]] != "undefined") {
      return true;
    }
  }

  return false;
}

function getWhitelistedDomain(tab) {
  if (typeof whitelistedDomains[tab.hostname] != "undefined") {
    return tab.hostname;
  }

  for (const i in tab.host_levels) {
    if (typeof whitelistedDomains[tab.host_levels[i]] != "undefined") {
      return tab.host_levels[i];
    }
  }

  return false;
}

async function toggleWhitelist(tab) {
  if (tab.url.indexOf("http") != 0 || !tabList[tab.id]) {
    return;
  }

  if (tabList[tab.id].whitelisted) {
    // const hostname = getWhitelistedDomain(tabList[tab.id]);
    delete whitelistedDomains[tabList[tab.id].hostname];
  } else {
    whitelistedDomains[tabList[tab.id].hostname] = true;
  }

  chrome.storage.local.set(
    { whitelisted_domains: whitelistedDomains },
    function () {
      for (const i in tabList) {
        if (tabList[i].hostname == tabList[tab.id].hostname) {
          tabList[i].whitelisted = !tabList[tab.id].whitelisted;
        }
      }
    }
  );
  if (isManifestV3) {
    await UpdateWhitelistRules();
  }
}

// Maintain tab list

function getPreparedTab(tab) {
  tab.hostname = false;
  tab.whitelisted = false;
  tab.host_levels = [];

  if (tab.url) {
    tab.hostname = getHostname(tab.url, true);

    if (tab.hostname) {
      const parts = tab.hostname.split(".");

      for (let i = parts.length; i >= 2; i--) {
        tab.host_levels.push(parts.slice(-1 * i).join("."));
      }

      tab.whitelisted = isWhitelisted(tab);
    }
  }

  return tab;
}

function onCreatedListener(tab) {
  tabList[tab.id] = getPreparedTab(tab);
}

function onUpdatedListener(tabId, changeInfo, tab) {
  if (changeInfo.status) {
    tabList[tab.id] = getPreparedTab(tab);
  }
}

function onRemovedListener(tabId) {
  if (tabList[tabId]) {
    delete tabList[tabId];
  }
}

function recreateTabList() {
  tabList = {};

  chrome.tabs.query({}, function (results) {
    results.forEach(onCreatedListener);

    for (const i in tabList) {
      doTheMagic(tabList[i].id);
    }
  });
}

chrome.tabs.onCreated.addListener(onCreatedListener);
chrome.tabs.onUpdated.addListener(onUpdatedListener);
chrome.tabs.onRemoved.addListener(onRemovedListener);

chrome.runtime.onStartup.addListener(function (d) {
  cachedRules = {};
  recreateTabList();
});

chrome.runtime.onInstalled.addListener(function (d) {
  cachedRules = {};

  if (
    d.reason == "update" &&
    chrome.runtime.getManifest().version > d.previousVersion
  ) {
    recreateTabList();
  }
});

// URL blocking

function blockUrlCallback(d) {
  // Cached request: find the appropriate tab
  // TODO: parse rules.json for this function.

  if (d.tabId == -1 && d.initiator) {
    // const hostname = getHostname(d.initiator, true);
    for (const tabId in tabList) {
      if (tabList[tabId].hostname == getHostname(d.initiator, true)) {
        d.tabId = parseInt(tabId);
        break;
      }
    }
  }

  if (tabList[d.tabId] && !tabList[d.tabId].whitelisted && d.url) {
    const cleanURL = d.url.split("?")[0];

    // To shorten the checklist, many filters are grouped by keywords

    for (const group in blockUrls.common_groups) {
      if (d.url.indexOf(group) > -1) {
        const groupFilters = blockUrls.common_groups[group];

        for (const i in groupFilters) {
          if (
            (groupFilters[i].q && d.url.indexOf(groupFilters[i].r) > -1) ||
            (!groupFilters[i].q && cleanURL.indexOf(groupFilters[i].r) > -1)
          ) {
            // Check for exceptions

            if (groupFilters[i].e && tabList[d.tabId].host_levels.length > 0) {
              for (const level in tabList[d.tabId].host_levels) {
                for (const exception in groupFilters[i].e) {
                  if (
                    groupFilters[i].e[exception] ==
                    tabList[d.tabId].host_levels[level]
                  ) {
                    return { cancel: false };
                  }
                }
              }
            }

            return { cancel: true };
          }
        }
      }
    }

    // Check ungrouped filters

    const groupFilters = blockUrls.common;

    for (const i in groupFilters) {
      if (
        (groupFilters[i].q && d.url.indexOf(groupFilters[i].r) > -1) ||
        (!groupFilters[i].q && cleanURL.indexOf(groupFilters[i].r) > -1)
      ) {
        // Check for exceptions

        if (groupFilters[i].e && tabList[d.tabId].host_levels.length > 0) {
          for (const level in tabList[d.tabId].host_levels) {
            for (const exception in groupFilters[i].e) {
              if (
                groupFilters[i].e[exception] ==
                tabList[d.tabId].host_levels[level]
              ) {
                return { cancel: false };
              }
            }
          }
        }

        return { cancel: true };
      }
    }

    // Site specific filters

    if (d.tabId > -1 && tabList[d.tabId].host_levels.length > 0) {
      for (const level in tabList[d.tabId].host_levels) {
        if (blockUrls.specific[tabList[d.tabId].host_levels[level]]) {
          const rules = blockUrls.specific[tabList[d.tabId].host_levels[level]];

          for (const i in rules) {
            if (d.url.indexOf(rules[i]) > -1) {
              return { cancel: true };
            }
          }
        }
      }
    }
  }

  return { cancel: false };
}
if (!isManifestV3) {
  chrome.webRequest.onBeforeRequest.addListener(
    blockUrlCallback,
    {
      urls: ["http://*/*", "https://*/*"],
      types: ["script", "stylesheet", "xmlhttprequest"],
    },
    ["blocking"]
  );

  chrome.webRequest.onHeadersReceived.addListener(
    function (d) {
      if (tabList[d.tabId]) {
        d.responseHeaders.forEach(function (h) {
          if (h.name == "Content-Type" || h.name == "content-type") {
            xmlTabs[d.tabId] = h.value.indexOf("/xml") > -1;
          }
        });
      }

      return { cancel: false };
    },
    { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
    ["blocking", "responseHeaders"]
  );
}
// Reporting

function reportWebsite(info, tab) {
  if (tab.url.indexOf("http") != 0 || !tabList[tab.id]) {
    return;
  }

  const hostname = getHostname(tab.url);

  if (hostname.length == 0) {
    return;
  }

  if (tabList[tab.id].whitelisted) {
    return chrome.notifications.create("report", {
      type: "basic",
      title: chrome.i18n.getMessage("reportSkippedTitle", hostname),
      message: chrome.i18n.getMessage("reportSkippedMessage"),
      iconUrl: "icons/48.png",
    });
  }

  chrome.tabs.create({
    url: "https://github.com/OhMyGuus/I-Dont-Care-About-Cookies/issues/new",
  });
}

// Adding custom CSS/JS

function activateDomain(hostname, tabId, frameId) {
  if (!cachedRules[hostname]) {
    cachedRules[hostname] = rules[hostname] || {};
  }

  if (!cachedRules[hostname]) {
    return false;
  }

  const cachedRule = cachedRules[hostname];
  let status = false;

  // cached_rule.s = Custom css for webpage
  // cached_rule.c = Common css for webpage
  // cached_rule.j = Common js  for webpage

  if (typeof cachedRule.s != "undefined") {
    insertCSS({ tabId, frameId: frameId || 0, css: cachedRule.s });
    status = true;
  }

  if (typeof cachedRule.c != "undefined") {
    insertCSS({ tabId, frameId: frameId || 0, css: commons[cachedRule.c] });
    status = true;
  }

  if (typeof cachedRule.j != "undefined") {
    executeScript({
      tabId,
      frameId,
      file:
        "data/js/" +
        (cachedRule.j > 0 ? "common" + cachedRule.j : hostname) +
        ".js",
    });
    status = true;
  }

  return status;
}

function doTheMagic(tabId, frameId, anotherTry) {
  if (!tabList[tabId] || tabList[tabId].url.indexOf("http") != 0) {
    return;
  }

  if (tabList[tabId].whitelisted) {
    return;
  }

  // Common CSS rules
  insertCSS(
    { tabId, frameId: frameId || 0, file: "data/css/common.css" },
    function () {
      // A failure? Retry.
      if (chrome.runtime.lastError) {
        console.log(chrome.runtime.lastError);

        const currentTry = anotherTry || 1;

        if (currentTry == 5) {
          return;
        }

        return doTheMagic(tabId, frameId || 0, currentTry + 1);
      }

      // Common social embeds
      executeScript({ tabId, frameId, file: "data/js/embeds.js" });

      if (activateDomain(tabList[tabId].hostname, tabId, frameId || 0)) {
        return;
      }

      for (const level in tabList[tabId].host_levels) {
        if (
          activateDomain(tabList[tabId].host_levels[level], tabId, frameId || 0)
        ) {
          return true;
        }
      }

      // Common JS rules when custom rules don't exist
      executeScript({ tabId, frameId, file: "data/js/common.js" });
    }
  );
}

chrome.webNavigation.onCommitted.addListener(function (tab) {
  if (tab.frameId > 0) {
    return;
  }

  tabList[tab.tabId] = getPreparedTab(tab);

  doTheMagic(tab.tabId);
});

chrome.webRequest.onResponseStarted.addListener(
  function (tab) {
    if (tab.frameId > 0) {
      doTheMagic(tab.tabId, tab.frameId);
    }
  },
  { urls: ["<all_urls>"], types: ["sub_frame"] }
);

// Toolbar menu

chrome.runtime.onMessage.addListener(function (request, info, sendResponse) {
  if (typeof request == "object") {
    if (request.tabId && tabList[request.tabId]) {
      if (request.command == "get_active_tab") {
        const response = { tab: tabList[request.tabId] };

        if (response.tab.whitelisted) {
          response.tab.hostname = getWhitelistedDomain(tabList[request.tabId]);
        }

        sendResponse(response);
      } else if (request.command == "toggle_extension") {
        toggleWhitelist(tabList[request.tabId]);
      } else if (request.command == "report_website") {
        chrome.tabs.create({
          url:
            "https://github.com/OhMyGuus/I-Dont-Care-About-Cookies/issues/new?assignees=OhMyGuus&labels=Website+request&template=site-request.md&title=%5BREQ%5D+Website+request%3A+" +
            encodeURIComponent(tabList[request.tabId].url),
        });
      } else if (request.command == "refresh_page") {
        executeScript({
          tabId: request.tabId,
          func: () => {
            window.location.reload();
          },
        });
      }
    } else {
      if (request.command == "open_options_page") {
        chrome.tabs.create({ url: chrome.runtime.getURL("data/options.html") });
      }
    }
  }
});

function insertCSS(injection, callback) {
  const { tabId, css, file, frameId } = injection;

  if (isManifestV3) {
    chrome.scripting.insertCSS(
      {
        target: { tabId: tabId, frameIds: [frameId || 0] },
        css: css,
        files: file ? [file] : undefined,
      },
      callback
    );
  } else {
    chrome.tabs.insertCSS(
      tabId,
      {
        file,
        code: css,
        frameId: frameId || 0,
        runAt: xmlTabs[tabId] ? "document_idle" : "document_start",
      },
      callback
    );
  }
}

function executeScript(injection, callback) {
  const { tabId, func, file, frameId } = injection;
  if (isManifestV3) {
    // manifest v3
    chrome.scripting.executeScript(
      {
        target: { tabId, frameIds: [frameId || 0] },
        files: file ? [file] : undefined,
        func,
      },
      callback
    );
  } else {
    // manifest v2
    chrome.tabs.executeScript(
      tabId,
      {
        file,
        frameId: frameId || 0,
        code: func == undefined ? undefined : "(" + func.toString() + ")();",
        runAt: xmlTabs[tabId] ? "document_idle" : "document_end",
      },
      callback
    );
  }
}
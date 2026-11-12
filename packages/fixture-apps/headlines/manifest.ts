import { defineApp } from "@hearth/sdk";

export default defineApp({
  id: "headlines",
  name: { en: "Headlines", zh: "头条" },
  description: {
    en: "The latest headlines of a sample news feed, fetched every hour.",
    zh: "示例新闻源的最新头条，每小时获取一次。",
  },
  icon: "file-text",
  color: "orange",
  widget: { size: "tall" },
  // The one host the app's job fetches from. The dialog that adds the app names it.
  network: ["feeds.example.com"],
  messages: {
    en: {
      emptyFirst: "No headlines yet. The first refresh is on its way.",
      empty: "No headlines yet.",
      none: "The feed has no headlines right now.",
      updatedNow: "Updated just now",
      updatedMinutes: "Updated {minutes} min ago",
      updatedAt: "Updated at {time}",
      refresh: "Refresh now",
      refreshing: "Refreshing…",
      failed: "Couldn't reach the feed at {time}.",
      failedShowing: "Couldn't reach the feed at {time}. Showing headlines from {previous}.",
    },
    zh: {
      emptyFirst: "还没有头条，第一次刷新马上就到。",
      empty: "还没有头条。",
      none: "订阅源目前没有头条。",
      updatedNow: "刚刚更新",
      updatedMinutes: "{minutes} 分钟前更新",
      updatedAt: "更新于 {time}",
      refresh: "立即刷新",
      refreshing: "正在刷新…",
      failed: "{time} 时无法连接订阅源。",
      failedShowing: "{time} 时无法连接订阅源。现在显示的是 {previous} 的头条。",
    },
  },
});

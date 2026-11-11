import { defineApp } from "@hearth/sdk";

export default defineApp({
  id: "feed",
  name: { en: "Feed", zh: "动态" },
  description: {
    en: "A sample card that each person filters for themselves.",
    zh: "每个人可以自行筛选的示例卡片。",
  },
  icon: "trending-up",
  color: "purple",
  widget: { size: "wide" },
  settings: {
    topics: {
      type: "multi-select",
      scope: "user",
      default: [],
      options: {
        science: { en: "Science", zh: "科学" },
        sport: { en: "Sport", zh: "体育" },
        food: { en: "Food", zh: "美食" },
      },
      label: { en: "Topics", zh: "主题" },
      help: { en: "Leave empty to follow every topic.", zh: "留空则关注所有主题。" },
    },
    period: {
      type: "select",
      scope: "user",
      default: "day",
      options: {
        day: { en: "Today", zh: "今天" },
        week: { en: "This week", zh: "本周" },
      },
      label: { en: "Period", zh: "时间范围" },
    },
  },
  messages: {
    en: {
      empty: "Nothing new.",
      following: "Following {count} topics",
    },
    zh: {
      empty: "没有新内容。",
      following: "关注了 {count} 个主题",
    },
  },
});

import { defineApp } from "@hearth/sdk";

export default defineApp({
  id: "checklist",
  name: { en: "Checklist", zh: "清单" },
  description: {
    en: "A list of things to do, ticked off as you go.",
    zh: "一份待办清单，完成一项勾选一项。",
  },
  icon: "list-checks",
  color: "teal",
  widget: { size: "tall" },
  settings: {
    sections: {
      type: "list",
      scope: "space",
      default: [],
      maxItems: 20,
      maxLength: 40,
      label: { en: "Sections", zh: "分组" },
      help: { en: "Items are grouped in this order.", zh: "事项按此顺序分组。" },
    },
    hideDone: {
      type: "switch",
      scope: "user",
      default: false,
      label: { en: "Hide ticked items", zh: "隐藏已勾选的事项" },
    },
  },
  messages: {
    en: {
      empty: "Nothing to do.",
      add: "Add an item",
      other: "Other",
      clear: "Clear ticked",
      left: "{count} left",
    },
    zh: {
      empty: "没有待办事项。",
      add: "添加事项",
      other: "其他",
      clear: "清除已勾选",
      left: "还剩 {count} 项",
    },
  },
});

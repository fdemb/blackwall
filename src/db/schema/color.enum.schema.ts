import { possibleColors } from "@/server/shared/colors";
import { text } from "drizzle-orm/sqlite-core";

export type ColorKey = (typeof possibleColors)[number];

export const colorKey = () => text("colorKey").$type<ColorKey>();

import { possibleColors } from "@/features/shared/colors";
import { text } from "drizzle-orm/sqlite-core";

export type ColorKey = (typeof possibleColors)[number];

export const colorKey = () => text("colorKey").$type<ColorKey>();

export const possibleColors = [
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "violet",
  "purple",
  "pink",
] as const;

export const createColorFromString = (
  input: string,
): (typeof possibleColors)[number] => {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }

  const index = Math.abs(hash) % possibleColors.length;
  return possibleColors[index] ?? "blue";
};

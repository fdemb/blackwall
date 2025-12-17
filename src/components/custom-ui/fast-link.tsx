import { Link, type LinkComponentProps } from "@tanstack/solid-router";

export const FastLink = (props: LinkComponentProps) => {
  return (
    <Link
      {...props}
      // onPointerDown={(e) => {
      //   e.target.click();
      // }}
    />
  );
};

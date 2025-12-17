import type { ValidComponent } from "solid-js";
import { Show, splitProps } from "solid-js";

import * as ImagePrimitive from "@kobalte/core/image";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";

import type { ColorKey, Team, User } from "@/db/schema";
import { cn } from "@/lib/utils";
import { createColorFromString } from "@/server/shared/colors";
import { cva, type VariantProps } from "class-variance-authority";
import UserIcon from "lucide-solid/icons/user";
import Users from "lucide-solid/icons/users";

type AvatarRootProps<T extends ValidComponent = "span"> =
  ImagePrimitive.ImageRootProps<T> & {
    class?: string | undefined;
  };

const avatarVariants = cva("relative flex shrink-0 overflow-hidden", {
  variants: {
    variant: {
      normal: "bg-muted",
    },
    size: {
      "4": "size-4 text-[10px]",
      "5": "size-5 text-[10px]",
      xs: "size-6 text-[10px]",
      sm: "size-7",
      md: "size-8",
      lg: "size-10",
    },
    shape: {
      square: "rounded-sm [corner-shape:squircle]",
      circle: "rounded-full",
    },
  },
  defaultVariants: {
    variant: "normal",
    size: "md",
    shape: "circle",
  },
});

const avatarFallbackVariants = cva(
  "flex size-full items-center justify-center bg-muted leading-none rounded-[inherit] ring-[0.5px] ring-inset ring-black/5",
  {
    variants: {
      color: {
        undefined: "",
        red: "bg-theme-red text-background",
        blue: "bg-theme-blue text-background",
        green: "bg-theme-green text-background",
        orange: "bg-theme-orange text-background",
        pink: "bg-theme-pink text-background",
        purple: "bg-theme-purple text-background",
        teal: "bg-theme-teal text-background",
        violet: "bg-theme-violet text-background",
        yellow: "bg-theme-yellow text-background",
      } satisfies Record<ColorKey | "undefined", string>,
    },
    defaultVariants: {
      color: "blue",
    },
  },
);

const Avatar = <T extends ValidComponent = "span">(
  props: PolymorphicProps<T, AvatarRootProps<T>> &
    VariantProps<typeof avatarVariants>,
) => {
  const [local, others] = splitProps(
    props as AvatarRootProps & VariantProps<typeof avatarVariants>,
    ["class", "variant", "size", "shape"],
  );
  return (
    <ImagePrimitive.Root
      class={cn(
        avatarVariants({
          variant: local.variant,
          size: local.size,
          shape: local.shape,
        }),
        local.class,
      )}
      {...others}
    />
  );
};

type AvatarImageProps<T extends ValidComponent = "img"> =
  ImagePrimitive.ImageImgProps<T> & {
    class?: string | undefined;
  };

const AvatarImage = <T extends ValidComponent = "img">(
  props: PolymorphicProps<T, AvatarImageProps<T>>,
) => {
  const [local, others] = splitProps(props as AvatarImageProps, ["class"]);
  return (
    <ImagePrimitive.Img
      class={cn("aspect-square size-full", local.class)}
      {...others}
    />
  );
};

type AvatarFallbackProps<T extends ValidComponent = "span"> =
  ImagePrimitive.ImageFallbackProps<T> & { class?: string | undefined };

const AvatarFallback = <T extends ValidComponent = "span">(
  props: PolymorphicProps<T, AvatarFallbackProps<T>> &
    VariantProps<typeof avatarFallbackVariants>,
) => {
  const [local, others] = splitProps(
    props as AvatarFallbackProps & VariantProps<typeof avatarFallbackVariants>,
    ["class", "color"],
  );
  return (
    <ImagePrimitive.Fallback
      class={cn(
        avatarFallbackVariants({
          color: local.color,
        }),
        local.class,
      )}
      {...others}
    />
  );
};

export function getInitials(name: string) {
  if (name.includes(" ")) {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("");
  }

  return name.slice(0, 2).toUpperCase();
}

const UserAvatar = (
  props: { user?: User | null; class?: string } & VariantProps<
    typeof avatarVariants
  >,
) => {
  return (
    <Avatar variant={props.variant} size={props.size} class={props.class}>
      <Show
        when={props.user}
        fallback={
          <AvatarFallback>
            <UserIcon class="size-4" />
          </AvatarFallback>
        }
      >
        {(user) => (
          <>
            <AvatarImage src={user().image!} />
            <AvatarFallback color={createColorFromString(user().name)}>
              {getInitials(user().name)}
            </AvatarFallback>
          </>
        )}
      </Show>
    </Avatar>
  );
};

const TeamAvatar = (
  props: { team?: Team | null; class?: string } & VariantProps<
    typeof avatarVariants
  >,
) => {
  const color = () => createColorFromString(props.team!.name);

  return (
    <Avatar
      variant={props.variant}
      size={props.size}
      class={cn(props.class, "shadow-xs")}
      shape="square"
    >
      <AvatarImage src={props.team!.avatar!} />
      <AvatarFallback color={color()} class="flex items-center justify-center">
        <Users class="size-[75%]" />
      </AvatarFallback>
    </Avatar>
  );
};

export { Avatar, AvatarFallback, AvatarImage, TeamAvatar, UserAvatar };

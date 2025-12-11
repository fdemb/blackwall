import {
  type Accessor,
  createContext,
  createEffect,
  createSignal,
  type JSX,
  onCleanup,
  useContext,
} from "solid-js";
import { tinykeys } from "tinykeys";

export type Keybinds = Record<string, (event: KeyboardEvent) => void>;

export type KeybindContextType = {
  keybinds: Accessor<Keybinds>;
  addKeybind: (key: string, callback: (event: KeyboardEvent) => void) => void;
  removeKeybind: (key: string) => void;
};

const KeybindContext = createContext<KeybindContextType>();

export function KeybindProvider(props: { children: JSX.Element }) {
  const [keybinds, setKeybinds] = createSignal<Keybinds>({});
  const addKeybind = (
    key: string,
    callback: (event: KeyboardEvent) => void,
  ) => {
    setKeybinds((prev) => ({ ...prev, [key]: callback }));
  };
  const removeKeybind = (key: string) => {
    setKeybinds((prev) => {
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  };

  const contextValue = {
    keybinds,
    addKeybind,
    removeKeybind,
  };

  createEffect(() => {
    const mapped = Object.entries(keybinds()).map(
      ([key, callback]) =>
        [
          key,
          (event: KeyboardEvent) => {
            const anyElement = document.activeElement as any;
            if (
              document.activeElement instanceof HTMLInputElement ||
              document.activeElement instanceof HTMLTextAreaElement ||
              document.activeElement instanceof HTMLSelectElement ||
              anyElement?.isContentEditable
            ) {
              return;
            }

            callback(event);
          },
        ] as const,
    );

    const unsubscribe = tinykeys(window, Object.fromEntries(mapped));

    onCleanup(() => {
      unsubscribe();
    });
  });

  return (
    <KeybindContext.Provider value={contextValue}>
      {props.children}
    </KeybindContext.Provider>
  );
}

export function useKeybinds() {
  const context = useContext(KeybindContext);
  if (!context) {
    throw new Error("useKeybinds must be used within a KeybindProvider.");
  }
  return context;
}

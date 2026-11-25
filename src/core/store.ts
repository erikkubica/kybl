/**
 * A tiny external store. Fast-changing state (transfer progress, job progress, sync status) lives
 * here instead of in App's state, so a progress tick re-renders only the components that show it,
 * not the whole window and every row in the file list.
 */
import { useSyncExternalStore } from "react";

export type Store<T> = {
  get: () => T;
  set: (next: T | ((cur: T) => T)) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      const value = typeof next === "function" ? (next as (cur: T) => T)(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Subscribes to a store. With a selector, the component re-renders only when the selected value
 * changes, so the selector must return a primitive or a value that is stable for the same state.
 */
export function useStore<T>(store: Store<T>): T;
export function useStore<T, S>(store: Store<T>, select: (state: T) => S): S;
export function useStore<T, S>(store: Store<T>, select?: (state: T) => S): T | S {
  const get: () => T | S = select ? () => select(store.get()) : store.get;
  return useSyncExternalStore<T | S>(store.subscribe, get, get);
}

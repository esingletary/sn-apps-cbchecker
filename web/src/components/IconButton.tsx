import type { ButtonHTMLAttributes } from "react";

// The small square header button style used throughout zscraper.
export default function IconButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={`shrink-0 rounded p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-600 disabled:opacity-50 disabled:hover:bg-transparent dark:text-stone-500 dark:hover:bg-stone-800 dark:hover:text-stone-300 dark:disabled:hover:bg-transparent ${className}`}
    />
  );
}

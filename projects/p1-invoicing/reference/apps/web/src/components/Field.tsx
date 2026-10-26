import { useId, type InputHTMLAttributes } from "react";

import { inputClass } from "./ui.ts";

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
}

export function TextField({ label, className, ...props }: FieldProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input id={id} className={`${inputClass} ${className ?? ""}`} {...props} />
    </div>
  );
}

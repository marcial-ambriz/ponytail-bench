import { useId, type SelectHTMLAttributes } from "react";

import { inputClass } from "./ui.ts";

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> {
  label: string;
}

export function SelectField({ label, className, children, ...props }: SelectFieldProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select id={id} className={`${inputClass} ${className ?? ""}`} {...props}>
        {children}
      </select>
    </div>
  );
}

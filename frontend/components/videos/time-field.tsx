"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatTimecode, parseTimecode } from "@/lib/videos";
import { cn } from "@/lib/utils";

/**
 * Campo hh:mm:ss.mmm. O valor só é aplicado com Enter ou ao sair do campo;
 * Escape repõe o valor atual. Fora de [min, max] fica marcado como inválido.
 */
export function TimeField({
  id,
  label,
  seconds,
  onCommit,
  min = 0,
  max,
  className,
}: {
  id: string;
  label?: string;
  seconds: number;
  onCommit: (seconds: number) => void;
  min?: number;
  max?: number;
  className?: string;
}) {
  const [text, setText] = useState(formatTimecode(seconds));
  const [invalid, setInvalid] = useState(false);
  const editing = useRef(false);

  // Acompanha o valor de fora (por exemplo, o playhead a andar), exceto
  // enquanto o utilizador está a escrever
  useEffect(() => {
    if (editing.current) return;
    setText(formatTimecode(seconds));
    setInvalid(false);
  }, [seconds]);

  function commit() {
    editing.current = false;
    const value = parseTimecode(text);
    if (value === null || value < min - 0.0005 || (max !== undefined && value > max + 0.0005)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (Math.abs(value - seconds) > 0.0005) onCommit(value);
    else setText(formatTimecode(seconds));
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && <Label htmlFor={id}>{label}</Label>}
      <Input
        id={id}
        value={text}
        inputMode="decimal"
        placeholder="hh:mm:ss.mmm"
        aria-label={label ? undefined : "Time (hh:mm:ss.mmm)"}
        aria-invalid={invalid}
        className={cn("h-8 font-mono", invalid && "border-destructive focus-visible:ring-destructive")}
        onFocus={() => (editing.current = true)}
        onChange={(e) => {
          editing.current = true;
          setText(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            editing.current = false;
            setText(formatTimecode(seconds));
            setInvalid(false);
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

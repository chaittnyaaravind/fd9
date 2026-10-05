import { useRef, useState } from "react";

interface Props {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}

export function Dropzone({ onFiles, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(false);

  function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    onFiles(Array.from(list));
  }

  return (
    <label
      className={`dropzone${active ? " is-active" : ""}`}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      htmlFor="fd9-file-input"
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setActive(true);
      }}
      onDragLeave={() => setActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setActive(false);
        if (!disabled) handleFiles(e.dataTransfer.files);
      }}
    >
      <strong>Drop files here, or click to choose</strong>
      <span>Any file type · no size limit from Fd9 itself</span>
      <input
        id="fd9-file-input"
        ref={inputRef}
        type="file"
        multiple
        disabled={disabled}
        style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", opacity: 0 }}
        tabIndex={-1}
        onChange={(e) => handleFiles(e.target.files)}
      />
    </label>
  );
}

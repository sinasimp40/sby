import { forwardRef, useRef, useState, type ComponentProps } from "react";
import { messageEmojiToken, parseMessageEmojis } from "@workspace/api-zod";
import { Smile, X } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { CustomEmojiPicker, EmojiPreview } from "@/components/custom-emoji-picker";

export function MessageEmojiText({ value }: { value: string }) {
  return <>{parseMessageEmojis(value).parts.map((part, index) =>
    part.customEmojiId ? <EmojiPreview key={index} customEmojiId={part.customEmojiId} fallback={part.text} className="h-[1.25em] w-[1.25em]" /> : part.text)}</>;
}

type Props = Omit<ComponentProps<typeof Textarea>, "value" | "onChange"> & {
  value: string; onChange: (value: string) => void; "data-testid"?: string;
};
export const MessageEmojiEditor = forwardRef<HTMLTextAreaElement, Props>(function MessageEmojiEditor(
  { value, onChange, onBlur, disabled, ...props }, forwardedRef,
) {
  const input = useRef<HTMLTextAreaElement | null>(null);
  const selection = useRef<{ start: number; end: number } | null>(null);
  const [open, setOpen] = useState(false);
  const remember = (element: HTMLTextAreaElement) => {
    selection.current = { start: element.selectionStart, end: element.selectionEnd };
  };
  return <div className="space-y-2" data-testid={`${props["data-testid"] ?? "message"}-editor`}>
    <Textarea {...props} disabled={disabled} value={value} ref={element => {
      input.current = element;
      if (typeof forwardedRef === "function") forwardedRef(element);
      else if (forwardedRef) forwardedRef.current = element;
    }} onSelect={event => remember(event.currentTarget)}
      onBlur={event => { remember(event.currentTarget); onBlur?.(event); }}
      onChange={event => { remember(event.currentTarget); onChange(event.currentTarget.value); }} />
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="outline" disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <X className="mr-1.5 h-3.5 w-3.5" /> : <Smile className="mr-1.5 h-3.5 w-3.5" />}
        {open ? "Close emoji library" : "Insert custom emoji"}
      </Button>
      <span className="text-[11px] text-muted-foreground">{parseMessageEmojis(value).text.length} message characters</span>
    </div>
    <p className="text-[11px] text-muted-foreground">Custom emojis appear as markers in the editor and as icons in the preview. Delete the whole marker to remove an emoji.</p>
    {open && <CustomEmojiPicker open value={null} mode="insert" fallbackEmoji="" disabled={disabled} onChange={(id, item) => {
      if (!id || !item) return;
      const marker = messageEmojiToken(id, item.emoji);
      const start = Math.min(selection.current?.start ?? value.length, value.length);
      const end = Math.min(selection.current?.end ?? value.length, value.length);
      onChange(value.slice(0, start) + marker + value.slice(end));
      const caret = start + marker.length;
      selection.current = { start: caret, end: caret };
      requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(caret, caret); });
    }} />}
  </div>;
});

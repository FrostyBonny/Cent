import dayjs, { type Dayjs } from "dayjs";
import type React from "react";
import {
    type ReactNode,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import { useIsDesktop } from "@/hooks/use-media-query";
import { useIntl } from "@/locale";
import { cn } from "@/utils";
import { denseDate } from "@/utils/time";
import { Calendar } from "./ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

type Props = {
    value?: number;
    displayFormatter?: string | ((time?: Dayjs) => string);
    onChange?: (value: number) => void;
    children?: React.ReactNode;
    onBlur?: () => void;
    /** 切换日期时不将时间重置为00:00 */
    fixedTime?: boolean;
};

const Hours = Array.from({ length: 24 }, (_, i) => ({
    label: `${i}`.padStart(2, "0"),
    value: `${i}`,
}));
const Minutes = Array.from({ length: 60 }, (_, i) => ({
    label: `${i}`.padStart(2, "0"),
    value: `${i}`,
}));

/** 滚轮单项高度(px) */
const ITEM_HEIGHT = 36;
/** 可见项数(奇数,选中项居中) */
const VISIBLE_ITEMS = 5;

/** 首尾两端的补白项数,让第一项和最后一项也能滚到中间 */
const EDGE_ITEMS = Math.floor(VISIBLE_ITEMS / 2);

/** 环形滚轮渲染的副本数:列表首尾拼接两次,实现 59→00 无缝回绕 */
const REPEAT = 2;

const indexOf = (options: { value: string }[], v: string) =>
    Math.max(
        options.findIndex((o) => o.value === v),
        0,
    );

/**
 * 滚轮选择列:触摸滑动/鼠标滚轮 + 滚动吸附居中。
 * 滚动过程中仅高亮跟随,停止后才提交 onChange,避免高频触发外层逻辑(如币种换算)。
 */
function TimeWheel({
    options,
    value,
    label,
    onChange,
}: {
    options: { label: string; value: string }[];
    value: string;
    label: string;
    onChange?: (v: string) => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const timer = useRef<number | undefined>(undefined);
    /** 最近一次提交给外部(或同步自外部)的值。
     *  值为 null 表示尚未定位(首次挂载);自身滚动回传的值与外部值相等时不做任何干预,
     *  避免把用户刚滚到的位置强行拉回。 */
    const lastCommitted = useRef<string | null>(null);
    const n = options.length;
    // 初始定位在第二份副本,保证两个方向都能无缝回绕
    const [selected, setSelected] = useState(() => n + indexOf(options, value));

    const commit = useCallback(
        (scrollTop: number) => {
            const idx = Math.min(
                Math.max(Math.round(scrollTop / ITEM_HEIGHT), 0),
                REPEAT * n - 1,
            );
            setSelected(idx);
            const v = options[idx % n].value;
            if (v !== lastCommitted.current) {
                lastCommitted.current = v;
                onChange?.(v);
            }
        },
        [options, onChange, n],
    );

    // 初始定位 + 仅外部值变化时同步滚轮(如日历换日期、点"现在")。
    // 用户滚动 → commit → onChange 回传的值 === lastCommitted,直接跳过,不干预滚动位置。
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        if (value === lastCommitted.current) {
            return;
        }
        lastCommitted.current = value;
        const idx = n + indexOf(options, value);
        el.scrollTop = idx * ITEM_HEIGHT;
    }, [options, value, n]);

    const clampIdx = (i: number) => Math.min(Math.max(i, 0), REPEAT * n - 1);

    /** 环形回绕:接近物理边界时跳到另一份副本的对应位置,实现无缝循环 */
    const wrap = () => {
        const el = ref.current;
        if (!el) return;
        if (el.scrollTop < 0.5 * ITEM_HEIGHT) {
            // 顶部:00 继续向上 → 59(第一份副本末尾)
            el.scrollTop = (n - 1) * ITEM_HEIGHT;
        } else if (el.scrollTop > (REPEAT * n - 1.5) * ITEM_HEIGHT) {
            // 底部:59 继续向下 → 00(第二份副本开头)
            el.scrollTop = n * ITEM_HEIGHT;
        }
    };

    /** 手势停止后:回绕 → 平滑吸附到最近项 → 稍后提交(提交也由 scrollend 兜底) */
    const settle = () => {
        const el = ref.current;
        if (!el) return;
        wrap();
        const idx = clampIdx(Math.round(el.scrollTop / ITEM_HEIGHT));
        if (Math.abs(el.scrollTop - idx * ITEM_HEIGHT) > 1) {
            el.scrollTo({ top: idx * ITEM_HEIGHT, behavior: "smooth" });
        }
        window.clearTimeout(timer.current);
        // 无 scrollend 的浏览器兜底:等平滑动画结束后再提交
        timer.current = window.setTimeout(() => {
            const el2 = ref.current;
            if (el2) commit(el2.scrollTop);
        }, 300);
    };

    const onScroll = () => {
        const el = ref.current;
        if (!el) return;
        // 滚动过程只跟随高亮;提交在停止后
        setSelected(clampIdx(Math.round(el.scrollTop / ITEM_HEIGHT)));
    };

    // 鼠标滚轮:记账弹窗内被 react-remove-scroll 锁定,原生滚动会被 preventDefault,
    // 因此直接手动移动 scrollTop(脚本滚动不受锁影响),停止后吸附+提交
    const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        const el = ref.current;
        if (!el) return;
        el.scrollTop += e.deltaY;
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(settle, 150);
    };

    // 触摸/鼠标拖拽:pointer 事件手动滚动(touch-none 让浏览器不处理原生手势)
    const dragRef = useRef<{ startY: number; startTop: number } | null>(null);
    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        const el = ref.current;
        if (!el) return;
        window.clearTimeout(timer.current);
        dragRef.current = { startY: e.clientY, startTop: el.scrollTop };
        e.currentTarget.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const el = ref.current;
        const d = dragRef.current;
        if (!el || !d) return;
        el.scrollTop = d.startTop - (e.clientY - d.startY);
    };
    const endDrag = () => {
        if (!dragRef.current) return;
        dragRef.current = null;
        settle();
    };

    // 平滑吸附结束后立即提交(scrollend 不支持的浏览器靠 settle 的定时器兜底)
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const onScrollEnd = () => {
            window.clearTimeout(timer.current);
            commit(el.scrollTop);
        };
        el.addEventListener("scrollend", onScrollEnd, { passive: true });
        return () => el.removeEventListener("scrollend", onScrollEnd);
    }, [commit]);

    useEffect(
        () => () => {
            window.clearTimeout(timer.current);
        },
        [],
    );

    return (
        <div className="relative">
            <div
                ref={ref}
                role="listbox"
                aria-label={label}
                onScroll={onScroll}
                onWheel={onWheel}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                className="w-12 overflow-y-auto overscroll-contain touch-none select-none cursor-grab active:cursor-grabbing [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_bottom,transparent,black_18%,black_82%,transparent)]"
                style={{ height: ITEM_HEIGHT * VISIBLE_ITEMS }}
            >
                <div
                    style={{
                        paddingTop: ITEM_HEIGHT * EDGE_ITEMS,
                        paddingBottom: ITEM_HEIGHT * EDGE_ITEMS,
                    }}
                >
                    {Array.from({ length: REPEAT * n }, (_, i) => {
                        const o = options[i % n];
                        return (
                            <div
                                key={`${i}-${o.value}`}
                                role="option"
                                aria-selected={i === selected}
                                tabIndex={i === selected ? 0 : -1}
                                className={cn(
                                    "h-9 flex items-center justify-center text-sm transition-colors",
                                    i === selected
                                        ? "text-foreground font-semibold"
                                        : "text-muted-foreground",
                                )}
                            >
                                {o.label}
                            </div>
                        );
                    })}
                </div>
            </div>
            {/* 中心高亮条 */}
            <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-9 rounded-md border-y border-border bg-primary/5" />
        </div>
    );
}

/** 日期 | 时间 分段切换 */
function SegmentedControl({
    value,
    onChange,
    options,
}: {
    value: string;
    onChange: (v: string) => void;
    options: { value: string; label: string }[];
}) {
    return (
        <div className="flex rounded-lg bg-muted p-0.5">
            {options.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    onClick={() => onChange(o.value)}
                    className={cn(
                        "flex-1 cursor-pointer rounded-md px-3 py-1 text-sm transition-colors",
                        value === o.value
                            ? "bg-background font-medium text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                    )}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

/** 时间面板:滚轮 + "现在"快捷按钮 */
function TimeSection({
    current,
    onChange,
}: {
    current: Dayjs;
    onChange?: (v: number) => void;
}) {
    const t = useIntl();
    return (
        <div className="flex flex-col items-center gap-1">
            <div className="flex w-full items-center justify-end">
                <button
                    type="button"
                    className="cursor-pointer rounded-full border border-input px-3 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    onClick={() => {
                        // "现在" = 当前日期 + 当前时间
                        onChange?.(dayjs().unix() * 1000);
                    }}
                >
                    {t("now")}
                </button>
            </div>
            <div className="flex items-center justify-center gap-1">
                <TimeWheel
                    value={current.format("HH")}
                    options={Hours}
                    label="Choose the Hour"
                    onChange={(v) => {
                        const newValue = current.hour(Number(v));
                        onChange?.(newValue.unix() * 1000);
                    }}
                />
                <span className="text-muted-foreground">:</span>
                <TimeWheel
                    value={current.format("mm")}
                    options={Minutes}
                    label="Choose the Minute"
                    onChange={(v) => {
                        const newValue = current.minute(Number(v));
                        onChange?.(newValue.unix() * 1000);
                    }}
                />
            </div>
        </div>
    );
}

/** 日期/时间 共享面板 */
function PickerPanel({
    current,
    fixedTime,
    onChange,
}: {
    current: Dayjs;
    fixedTime?: boolean;
    onChange?: (v: number) => void;
}) {
    const t = useIntl();
    const [tab, setTab] = useState<"date" | "time">("date");

    return (
        <div className="flex flex-col gap-3">
            <SegmentedControl
                value={tab}
                onChange={(v) => setTab(v as "date" | "time")}
                options={[
                    { value: "date", label: t("date") },
                    { value: "time", label: t("time") },
                ]}
            />
            {tab === "date" ? (
                <Calendar
                    mode="single"
                    captionLayout="dropdown"
                    className="rounded-md p-0 mx-auto"
                    selected={current.toDate()}
                    onSelect={(v) => {
                        if (v) {
                            const x = new Date(v);
                            if (fixedTime) {
                                x.setHours(current.hour());
                                x.setMinutes(current.minute());
                            }
                            onChange?.(x.getTime());
                        }
                    }}
                />
            ) : (
                <TimeSection current={current} onChange={onChange} />
            )}
        </div>
    );
}

/**
 * 移动端底部抽屉。
 * 用 createPortal 渲染到 body:记账弹窗带 transform 动画,会改变 fixed 的定位锚点,
 * portal 出去才能保证铺满视口,同时避免嵌套弹窗的动画生命周期问题。
 */
function MobileSheet({
    open,
    onClose,
    children,
}: {
    open: boolean;
    onClose: () => void;
    children: ReactNode;
}) {
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, onClose]);

    if (!open) return null;

    return createPortal(
        <div className="pointer-events-none fixed inset-0 z-50 flex items-end justify-center">
            <button
                type="button"
                aria-label="Close"
                className="pointer-events-auto absolute inset-0 cursor-pointer bg-black/50"
                onClick={onClose}
            />
            <div
                role="dialog"
                aria-modal="true"
                className="pointer-events-auto relative w-full max-h-[70vh] overflow-y-auto rounded-t-xl bg-popover p-4 pb-[calc(1rem+var(--safe-area-inset-bottom))] shadow-lg animate-in slide-in-from-bottom-12 fade-in-0 duration-300"
            >
                <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted-foreground/30" />
                {children}
            </div>
        </div>,
        document.body,
    );
}

export function DatePicker({
    value,
    displayFormatter = (v) => (v ? denseDate(v) : ""),
    onChange,
    children,
    onBlur,
    fixedTime,
}: Props) {
    const isDesktop = useIsDesktop();
    const [open, setOpen] = useState(false);

    // display 格式化函数
    const display =
        typeof displayFormatter === "function"
            ? displayFormatter
            : (d?: Dayjs) => d?.format(displayFormatter as string);

    const current = value ? dayjs(value) : dayjs();

    const close = useCallback(() => {
        setOpen(false);
        onBlur?.();
    }, [onBlur]);

    const trigger = (
        <div className="flex justify-center items-center relative cursor-pointer">
            {children}
            <div className="mx-2">{display(value ? current : undefined)}</div>
        </div>
    );

    const panel = (
        <PickerPanel
            current={current}
            fixedTime={fixedTime}
            onChange={onChange}
        />
    );

    // 移动端:底部抽屉
    if (!isDesktop) {
        return (
            <>
                <button
                    type="button"
                    className="cursor-pointer"
                    onClick={() => setOpen(true)}
                >
                    {trigger}
                </button>
                <MobileSheet open={open} onClose={close}>
                    {panel}
                </MobileSheet>
            </>
        );
    }

    // 桌面:锚定弹层
    return (
        <Popover
            open={open}
            onOpenChange={(v) => {
                setOpen(v);
                if (!v) {
                    onBlur?.();
                }
            }}
        >
            <PopoverTrigger>{trigger}</PopoverTrigger>
            <PopoverContent
                className="w-auto overflow-hidden p-3"
                align="center"
                side="bottom"
                sideOffset={-36}
            >
                {panel}
            </PopoverContent>
        </Popover>
    );
}

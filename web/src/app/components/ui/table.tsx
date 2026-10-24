import type * as React from "react";
import { cn } from "../../lib/utils";

export function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}
export const TableHeader = ({ className, ...p }: React.ComponentProps<"thead">) => <thead className={cn("[&_tr]:border-b", className)} {...p} />;
export const TableBody = ({ className, ...p }: React.ComponentProps<"tbody">) => <tbody className={cn("[&_tr:last-child]:border-0", className)} {...p} />;
export const TableRow = ({ className, ...p }: React.ComponentProps<"tr">) => <tr className={cn("border-b transition-colors hover:bg-muted/50", className)} {...p} />;
export const TableHead = ({ className, ...p }: React.ComponentProps<"th">) => (
  <th className={cn("h-10 px-2 text-left align-middle font-mono text-[10px] font-medium tracking-widest whitespace-nowrap text-slate-500 uppercase", className)} {...p} />
);
export const TableCell = ({ className, ...p }: React.ComponentProps<"td">) => <td className={cn("p-2 align-middle whitespace-nowrap", className)} {...p} />;

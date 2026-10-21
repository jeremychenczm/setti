import { z } from "zod";

export const aiOutputSchema = z.strictObject({
  intent: z.enum(["draft", "clarify", "answer", "cancel"]),
  message: z.string().min(1).max(4000),
  title: z.string().max(160),
  changes: z.array(z.strictObject({
    action: z.enum(["quantity", "remove", "replace", "add"]),
    itemId: z.string().nullable(),
    quantity: z.number().int().min(1).max(10000).nullable(),
    productOptionId: z.string().nullable(),
    description: z.string().max(1000),
    sourceMessageIds: z.array(z.string()).min(1).max(100),
  })).max(40),
  unresolved: z.array(z.string().min(1).max(500)).max(30),
  constraints: z.array(z.string().min(1).max(500)).max(30),
});

export type AiOutput = z.infer<typeof aiOutputSchema>;

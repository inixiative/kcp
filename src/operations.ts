import type { DeclaredOperation, OperationInput } from '@inixiative/signet/contracts';
import type { ProviderFamily } from './selectors';

/** A resource of the resolved integration a parser may name, as `access/describe` reports it. */
export type OperationResource = { id: string; name: string; kind: string };

/** A command parsed into one declared operation's typed input; Kingdom never sees the argv. */
export type ParsedOperation = {
  [O in DeclaredOperation]: { operation: O; resourceId: string; input: OperationInput<O> };
}[DeclaredOperation];

/** A command that doesn't parse into any operation's input: nothing to grant, so nothing is sent. */
export type RefusedOperation = { refused: string };

export type OperationParser = (
  args: readonly string[],
  context: { binary: string; resources: readonly OperationResource[] },
) => ParsedOperation | RefusedOperation;

/**
 * One parser per provider family, turning a CLI's argv into the typed input of an operation
 * `@inixiative/signet` declares. Empty until the CLI operations are declared there
 * (OPERATOR-ACCESS §9, §11 step 1).
 */
export const operationParsers: Partial<Record<ProviderFamily, OperationParser>> = {};

export class NoOperationsError extends Error {
  constructor(readonly family: ProviderFamily) {
    super(
      `No operations are declared for ${family} yet: Kingdom's catalog has no ${family} CLI operations, so KCP has nothing to send`,
    );
  }
}

export const isRefused = (parsed: ParsedOperation | RefusedOperation): parsed is RefusedOperation =>
  'refused' in parsed;

/** The operation a command is, or why it can't be one. */
export function parseOperation(
  family: ProviderFamily,
  args: readonly string[],
  context: Parameters<OperationParser>[1],
  parsers: Partial<Record<ProviderFamily, OperationParser>> = operationParsers,
) {
  const parser = parsers[family];
  if (!parser) throw new NoOperationsError(family);
  return parser(args, context);
}

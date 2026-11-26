// The suite was written against Vitest's matcher and mock types, which are looser than bun:test's; keep Vitest's.
import 'bun:test';

declare module 'bun:test' {
    interface Matchers<T> {
        toBe(expected: unknown): void;
        toEqual(expected: unknown): void;
        toStrictEqual(expected: unknown): void;
        toBeOneOf(expected: Iterable<unknown>): void;
        toContain(expected: unknown): void;
        toContainEqual(expected: unknown): void;
    }

    namespace JestMock {
        interface MockInstance<T extends FunctionLike = UnknownFunction> {
            mockResolvedValue(value: Awaited<ReturnType<T>>): this;
            mockResolvedValueOnce(value: Awaited<ReturnType<T>>): this;
            mockRejectedValue(value: unknown): this;
            mockRejectedValueOnce(value: unknown): this;
        }
    }
}

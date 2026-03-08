/*
 * mquickjs WASM bridge
 *
 * Thin wrapper exposing mquickjs to a host JS environment via emscripten.
 * Provides init/eval/free and a host-call trampoline for runtime-injected
 * host objects.
 */
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>
#include <emscripten.h>

#include "cutils.h"
#include "mquickjs.h"

/* –
 * Imports (provided by host via bridge_imports.js)
 * – */

/* Dispatch a host function call. Returns pointer to malloc'd JSON result
   string in WASM memory, or 0 for undefined. */
extern int host_call(int slot_id, const char *json_ptr, int json_len);

/* Send log output to the host. */
extern void host_log(const char *ptr, int len);

/* –
 * Engine state
 * – */

static JSContext *ctx;
static uint8_t *mem_buf;

/* –
 * Fuel (execution budget)
 * – */

/* Must match JS_INTERRUPT_COUNTER_INIT in mquickjs.c */
#define FUEL_TICK 10000

static int fuel_remaining; /* ticks left, or -1 for unlimited */

static int fuel_interrupt(JSContext *ctx, void *opaque)
{
    (void)opaque;
    if (fuel_remaining < 0) return 0; /* unlimited */
    fuel_remaining -= FUEL_TICK;
    return fuel_remaining <= 0;
}

/* –
 * Stdlib C functions referenced by bridge_stdlib
 * – */

static JSValue js_host_call_raw(JSContext *ctx, JSValue *this_val,
                                int argc, JSValue *argv)
{
    int slot_id;
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "expected (slotId, argsJson)");

    if (JS_ToInt32(ctx, &slot_id, argv[0]))
        return JS_EXCEPTION;

    JSCStringBuf str_buf;
    size_t json_len;
    const char *json = JS_ToCStringLen(ctx, &json_len, argv[1], &str_buf);
    if (!json)
        return JS_EXCEPTION;

    /* Copy to C heap before any mquickjs allocation (compacting GC safety) */
    char *json_copy = malloc(json_len + 1);
    if (!json_copy)
        return JS_ThrowOutOfMemory(ctx);
    memcpy(json_copy, json, json_len + 1);

    int result_ptr = host_call(slot_id, json_copy, (int)json_len);
    free(json_copy);

    if (!result_ptr)
        return JS_UNDEFINED;

    const char *result = (const char *)result_ptr;
    JSValue ret = JS_NewString(ctx, result);
    free((void *)result);
    return ret;
}

static JSValue js_print(JSContext *ctx, JSValue *this_val,
                        int argc, JSValue *argv)
{
    /* Build output string, send to host */
    char line[1024];
    int pos = 0;

    for (int i = 0; i < argc; i++) {
        if (i != 0 && pos < (int)sizeof(line) - 1)
            line[pos++] = ' ';

        JSValue v = argv[i];
        if (JS_IsString(ctx, v)) {
            JSCStringBuf buf;
            size_t len;
            const char *str = JS_ToCStringLen(ctx, &len, v, &buf);
            if (str) {
                size_t avail = sizeof(line) - 1 - pos;
                size_t n = len < avail ? len : avail;
                memcpy(line + pos, str, n);
                pos += n;
            }
        } else if (JS_IsInt(v)) {
            pos += snprintf(line + pos, sizeof(line) - pos, "%d",
                            JS_VALUE_GET_INT(v));
        } else if (JS_IsNull(v)) {
            pos += snprintf(line + pos, sizeof(line) - pos, "null");
        } else if (JS_IsUndefined(v)) {
            pos += snprintf(line + pos, sizeof(line) - pos, "undefined");
        } else if (JS_IsBool(v)) {
            pos += snprintf(line + pos, sizeof(line) - pos, "%s",
                            JS_VALUE_GET_SPECIAL_VALUE(v) ? "true" : "false");
        } else {
            /* Fall back to engine's print for objects/etc */
            JSCStringBuf buf;
            JSValue sv = JS_ToString(ctx, v);
            if (!JS_IsException(sv)) {
                size_t len;
                const char *str = JS_ToCStringLen(ctx, &len, sv, &buf);
                if (str) {
                    size_t avail = sizeof(line) - 1 - pos;
                    size_t n = len < avail ? len : avail;
                    memcpy(line + pos, str, n);
                    pos += n;
                }
            }
        }
    }

    line[pos] = '\0';
    host_log(line, pos);
    return JS_UNDEFINED;
}

#if defined(__linux__) || defined(__APPLE__) || defined(__EMSCRIPTEN__)
static int64_t get_time_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000 + (ts.tv_nsec / 1000000);
}
#else
static int64_t get_time_ms(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (int64_t)tv.tv_sec * 1000 + (tv.tv_usec / 1000);
}
#endif

static JSValue js_date_now(JSContext *ctx, JSValue *this_val,
                           int argc, JSValue *argv)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return JS_NewInt64(ctx, (int64_t)tv.tv_sec * 1000 + (tv.tv_usec / 1000));
}

static JSValue js_performance_now(JSContext *ctx, JSValue *this_val,
                                  int argc, JSValue *argv)
{
    return JS_NewInt64(ctx, get_time_ms());
}

/* Generated stdlib ROM tables */
#include "bridge_stdlib.h"

/* –
 * Log callback for JS_SetLogFunc
 * – */

static void js_log_func(void *opaque, const void *buf, size_t buf_len)
{
    host_log((const char *)buf, (int)buf_len);
}

/* –
 * Exported WASM API
 * – */

/* result_type encoding returned alongside the JSON string */
#define RESULT_OK    0
#define RESULT_ERROR 1

/* Shared result buffer for returning strings to the host */
static char *result_buf;

static void set_result(const char *str, size_t len)
{
    free(result_buf);
    result_buf = malloc(len + 1);
    if (result_buf) {
        memcpy(result_buf, str, len);
        result_buf[len] = '\0';
    }
}

EMSCRIPTEN_KEEPALIVE
int mqjs_init(int mem_size)
{
    if (ctx) return 0;

    mem_buf = malloc(mem_size);
    if (!mem_buf) return -1;

    ctx = JS_NewContext(mem_buf, mem_size, &js_stdlib);
    if (!ctx) {
        free(mem_buf);
        mem_buf = NULL;
        return -1;
    }

    JS_SetLogFunc(ctx, js_log_func);
    JS_SetInterruptHandler(ctx, fuel_interrupt);
    fuel_remaining = -1; /* unlimited until set */
    return 0;
}

/* Set execution fuel for the next eval. -1 = unlimited. */
EMSCRIPTEN_KEEPALIVE
void mqjs_set_fuel(int fuel)
{
    fuel_remaining = fuel;
}

/*
 * Evaluate JS code. Returns a pointer to a result string in WASM memory.
 * The string is a JSON envelope: {"ok":<json>} or {"err":"message"}.
 * Caller must NOT free the pointer; it's managed internally.
 */
EMSCRIPTEN_KEEPALIVE
const char *mqjs_eval(const char *code, int code_len)
{
    if (!ctx) {
        set_result("{\"err\":\"engine not initialized\"}", 31);
        return result_buf;
    }

    JSValue val = JS_Eval(ctx, code, code_len, "<eval>", JS_EVAL_RETVAL);

    /* Fast-path: primitives skip the JS_Call overhead of JSON.stringify */
    if (JS_IsUndefined(val) || JS_IsNull(val)) {
        set_result("{\"ok\":null}", 11);
        return result_buf;
    }

    if (JS_IsInt(val)) {
        char buf[32];
        int n = snprintf(buf, sizeof(buf), "{\"ok\":%d}", JS_VALUE_GET_INT(val));
        set_result(buf, n);
        return result_buf;
    }

    if (JS_IsBool(val)) {
        if (JS_VALUE_GET_SPECIAL_VALUE(val)) {
            set_result("{\"ok\":true}", 11);
        } else {
            set_result("{\"ok\":false}", 12);
        }
        return result_buf;
    }

    if (JS_IsString(ctx, val)) {
        JSCStringBuf sbuf;
        size_t slen;
        const char *s = JS_ToCStringLen(ctx, &slen, val, &sbuf);
        if (!s) {
            set_result("{\"ok\":null}", 11);
            return result_buf;
        }
        /* JSON-escape the string value */
        size_t cap = slen * 2 + 16;
        char *out = malloc(cap);
        if (!out) {
            set_result("{\"ok\":null}", 11);
            return result_buf;
        }
        int p = snprintf(out, cap, "{\"ok\":\"");
        for (size_t i = 0; i < slen && p < (int)cap - 4; i++) {
            char c = s[i];
            if (c == '"' || c == '\\') { out[p++] = '\\'; out[p++] = c; }
            else if (c == '\n') { out[p++] = '\\'; out[p++] = 'n'; }
            else if (c == '\r') { out[p++] = '\\'; out[p++] = 'r'; }
            else if (c == '\t') { out[p++] = '\\'; out[p++] = 't'; }
            else if ((unsigned char)c < 0x20) {
                p += snprintf(out + p, cap - p, "\\u%04x", (unsigned char)c);
            }
            else out[p++] = c;
        }
        p += snprintf(out + p, cap - p, "\"}");
        set_result(out, p);
        free(out);
        return result_buf;
    }

    if (JS_IsException(val)) {
        JSValue ex = JS_GetException(ctx);
        JSCStringBuf buf;
        const char *msg = JS_ToCString(ctx, ex, &buf);
        if (!msg) msg = "unknown error";

        size_t msg_len = strlen(msg);
        /* Build {"err":"<escaped_msg>"} */
        /* Worst case: every char needs escaping → 2x + envelope */
        size_t cap = msg_len * 2 + 32;
        char *out = malloc(cap);
        if (!out) {
            set_result("{\"err\":\"out of memory\"}", 22);
            return result_buf;
        }

        int pos = snprintf(out, cap, "{\"err\":\"");
        for (size_t i = 0; i < msg_len && pos < (int)cap - 4; i++) {
            char c = msg[i];
            if (c == '"' || c == '\\') {
                out[pos++] = '\\';
                out[pos++] = c;
            } else if (c == '\n') {
                out[pos++] = '\\';
                out[pos++] = 'n';
            } else if (c == '\r') {
                out[pos++] = '\\';
                out[pos++] = 'r';
            } else {
                out[pos++] = c;
            }
        }
        pos += snprintf(out + pos, cap - pos, "\"}");
        set_result(out, pos);
        free(out);
        return result_buf;
    }

    /* JSON.stringify the result via the guest engine */
    JSGCRef val_ref, json_ref, stringify_ref;
    JSValue *pval, *pjson, *pstringify;

    pval = JS_PushGCRef(ctx, &val_ref);
    *pval = val;

    JSValue global = JS_GetGlobalObject(ctx);

    pjson = JS_PushGCRef(ctx, &json_ref);
    *pjson = JS_GetPropertyStr(ctx, global, "JSON");

    pstringify = JS_PushGCRef(ctx, &stringify_ref);
    *pstringify = JS_GetPropertyStr(ctx, *pjson, "stringify");

    if (JS_IsUndefined(*pstringify) || JS_IsException(*pstringify)) {
        /* JSON.stringify not available; fall back to string coercion */
        JS_PopGCRef(ctx, &stringify_ref);
        JS_PopGCRef(ctx, &json_ref);

        JSCStringBuf buf;
        const char *s = JS_ToCString(ctx, *pval, &buf);
        JS_PopGCRef(ctx, &val_ref);

        if (!s) {
            set_result("{\"ok\":null}", 11);
        } else {
            /* Wrap as JSON string */
            size_t slen = strlen(s);
            size_t cap = slen * 2 + 16;
            char *out = malloc(cap);
            if (out) {
                int p = snprintf(out, cap, "{\"ok\":\"");
                for (size_t i = 0; i < slen && p < (int)cap - 4; i++) {
                    char c = s[i];
                    if (c == '"' || c == '\\') { out[p++] = '\\'; out[p++] = c; }
                    else if (c == '\n') { out[p++] = '\\'; out[p++] = 'n'; }
                    else if (c == '\r') { out[p++] = '\\'; out[p++] = 'r'; }
                    else out[p++] = c;
                }
                p += snprintf(out + p, cap - p, "\"}");
                set_result(out, p);
                free(out);
            } else {
                set_result("{\"ok\":null}", 11);
            }
        }
        return result_buf;
    }

    /* Call JSON.stringify(val) */
    if (JS_StackCheck(ctx, 3)) {
        JS_PopGCRef(ctx, &stringify_ref);
        JS_PopGCRef(ctx, &json_ref);
        JS_PopGCRef(ctx, &val_ref);
        set_result("{\"ok\":null}", 11);
        return result_buf;
    }

    JS_PushArg(ctx, *pval);
    JS_PushArg(ctx, *pstringify);
    JS_PushArg(ctx, *pjson);
    JSValue json_result = JS_Call(ctx, 1);

    JS_PopGCRef(ctx, &stringify_ref);
    JS_PopGCRef(ctx, &json_ref);
    JS_PopGCRef(ctx, &val_ref);

    if (JS_IsException(json_result) || JS_IsUndefined(json_result)) {
        set_result("{\"ok\":null}", 11);
        return result_buf;
    }

    JSCStringBuf sbuf;
    size_t rlen;
    const char *rstr = JS_ToCStringLen(ctx, &rlen, json_result, &sbuf);
    if (!rstr) {
        set_result("{\"ok\":null}", 11);
        return result_buf;
    }

    /* Build {"ok":<json_value>} */
    size_t cap = rlen + 16;
    char *out = malloc(cap);
    if (!out) {
        set_result("{\"ok\":null}", 11);
        return result_buf;
    }

    int p = snprintf(out, cap, "{\"ok\":");
    memcpy(out + p, rstr, rlen);
    p += rlen;
    out[p++] = '}';
    out[p] = '\0';

    set_result(out, p);
    free(out);
    return result_buf;
}

EMSCRIPTEN_KEEPALIVE
void mqjs_free(void)
{
    if (ctx) {
        JS_FreeContext(ctx);
        ctx = NULL;
    }
    free(mem_buf);
    mem_buf = NULL;
    free(result_buf);
    result_buf = NULL;
}

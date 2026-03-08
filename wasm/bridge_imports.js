/* Emscripten JS library providing WASM imports for the mquickjs bridge. */

mergeInto(LibraryManager.library, {
    host_call: function(slot_id, json_ptr, json_len) {
        var json = UTF8ToString(json_ptr, json_len);
        var callback = Module['__hostCallback'];
        if (!callback) return 0;

        function writeResult(str) {
            if (str === null || str === undefined) return 0;
            var len = lengthBytesUTF8(str) + 1;
            var ptr = _malloc(len);
            stringToUTF8(str, ptr, len);
            return ptr;
        }

        var result = callback(slot_id, json);

        /* Async handler — use Asyncify to suspend/resume the WASM stack */
        if (result && typeof result.then === 'function') {
            return Asyncify.handleAsync(function() {
                return result.then(writeResult);
            });
        }

        return writeResult(result);
    },

    host_log: function(ptr, len) {
        var str = UTF8ToString(ptr, len);
        var callback = Module['__logCallback'];
        if (callback) callback(str);
    }
});

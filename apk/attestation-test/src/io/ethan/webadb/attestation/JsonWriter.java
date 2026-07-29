package io.ethan.webadb.attestation;

import java.util.Map;

/**
 * Tiny one-purpose JSON writer — no dependency on Gson/Jackson so we can
 * build the APK without a full Gradle setup.
 */
public final class JsonWriter {
    private JsonWriter() {}

    public static String toJson(Object o) {
        StringBuilder sb = new StringBuilder();
        write(sb, o, 0);
        return sb.toString();
    }

    private static void write(StringBuilder sb, Object o, int indent) {
        if (o == null) { sb.append("null"); return; }
        if (o instanceof Boolean || o instanceof Number) { sb.append(o); return; }
        if (o instanceof String) { writeStr(sb, (String) o); return; }
        if (o instanceof Map) {
            writeMap(sb, (Map<?, ?>) o, indent);
            return;
        }
        if (o instanceof Iterable) {
            writeArr(sb, (Iterable<?>) o, indent);
            return;
        }
        if (o.getClass().isArray()) {
            writeArr(sb, java.util.Arrays.asList((Object[]) o), indent);
            return;
        }
        writeStr(sb, String.valueOf(o));
    }

    private static void writeMap(StringBuilder sb, Map<?, ?> m, int indent) {
        if (m.isEmpty()) { sb.append("{}"); return; }
        sb.append("{\n");
        int i = 0;
        for (Map.Entry<?, ?> e : m.entrySet()) {
            pad(sb, indent + 1);
            writeStr(sb, String.valueOf(e.getKey()));
            sb.append(": ");
            write(sb, e.getValue(), indent + 1);
            sb.append(++i < m.size() ? ",\n" : "\n");
        }
        pad(sb, indent);
        sb.append("}");
    }

    private static void writeArr(StringBuilder sb, Iterable<?> it, int indent) {
        sb.append("[\n");
        int i = 0;
        int count = 0;
        for (Object v : it) count++;
        int idx = 0;
        for (Object v : it) {
            pad(sb, indent + 1);
            write(sb, v, indent + 1);
            sb.append(++idx < count ? ",\n" : "\n");
        }
        pad(sb, indent);
        sb.append("]");
    }

    private static void writeStr(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
    }

    private static void pad(StringBuilder sb, int n) {
        for (int i = 0; i < n; i++) sb.append("  ");
    }
}

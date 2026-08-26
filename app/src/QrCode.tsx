/*
 * Minimal QR renderer with no native dependency: qrcode-generator produces the
 * module matrix, and we paint it as rows of Views. Each row collapses runs of
 * same-colored modules into a single View to keep the view count reasonable.
 */
import React from "react";
import {View} from "react-native";
import qrcode from "qrcode-generator";

export function QrCode({value, size = 220}: {value: string; size?: number}) {
  const qr = qrcode(0, "Q");
  qr.addData(value);
  qr.make();
  const count = qr.getModuleCount();
  const cell = size / count;

  const rows = [];
  for (let r = 0; r < count; r++) {
    const runs = [];
    let c = 0;
    while (c < count) {
      const dark = qr.isDark(r, c);
      let len = 1;
      while (c + len < count && qr.isDark(r, c + len) === dark) len++;
      runs.push(
          <View
              key={c}
              style={{
                width: cell * len,
                height: cell,
                backgroundColor: dark ? "#000" : "#fff",
              }}
          />);
      c += len;
    }
    rows.push(
        <View key={r} style={{flexDirection: "row"}}>
          {runs}
        </View>);
  }

  return (
    <View style={{padding: 12, backgroundColor: "#fff", borderRadius: 12}}>
      {rows}
    </View>
  );
}

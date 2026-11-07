// @ts-check
import { View } from "gpui-kit";
import { fail, next, reply } from "kagan/jobs";
import { handle } from "./drive.js";
import { messageOf } from "./core.js";

export default class Plugin extends View {
  /** @param {import("gpui-shell").Props | undefined} _props @param {import("gpui-kit").AsyncContext} cx */
  init(_props, cx) {
    cx.spawn(async () => {
      for (;;) {
        const job = await next();
        handle(job).then(
          (value) => reply(job.id, value),
          (error) => fail(job.id, messageOf(error)),
        );
      }
    });
  }

  render() {
    return "";
  }
}

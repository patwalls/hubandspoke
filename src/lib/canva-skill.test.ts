import { describe, it, expect } from "vitest";
import { extractCanvaTemplateId } from "./canva-skill";

describe("extractCanvaTemplateId", () => {
  it("returns null for null / undefined / empty input", () => {
    expect(extractCanvaTemplateId(null)).toBeNull();
    expect(extractCanvaTemplateId(undefined)).toBeNull();
    expect(extractCanvaTemplateId("")).toBeNull();
  });

  it("returns null when no Canva URL is present", () => {
    expect(
      extractCanvaTemplateId("Just some skill text with no URLs."),
    ).toBeNull();
    expect(
      extractCanvaTemplateId(
        "Reference: https://www.instagram.com/p/DOep-C8kjMI/?img_index=1",
      ),
    ).toBeNull();
  });

  it("extracts the design id from a bare canva.com URL", () => {
    expect(
      extractCanvaTemplateId(
        "https://www.canva.com/design/DAGytttEXSY/3ogzZwQKK0dRMMl8sYzDPw/edit",
      ),
    ).toBe("DAGytttEXSY");
  });

  it("extracts the design id from inside a markdown link", () => {
    const skill = `- [here is the canva template](https://www.canva.com/design/DAGytttEXSY/3ogzZwQKK0dRMMl8sYzDPw/edit?utm_source=sharebutton) you can use`;
    expect(extractCanvaTemplateId(skill)).toBe("DAGytttEXSY");
  });

  it("returns the first match when multiple design URLs are present", () => {
    const skill = `
      first: https://www.canva.com/design/DAFirst11111/abc/edit
      second: https://www.canva.com/design/DASecond2222/xyz/view
    `;
    expect(extractCanvaTemplateId(skill)).toBe("DAFirst11111");
  });

  it("does not match other canva.com paths (e.g. brand kits, templates browse)", () => {
    expect(
      extractCanvaTemplateId("https://www.canva.com/templates/social-media/"),
    ).toBeNull();
    expect(
      extractCanvaTemplateId("https://www.canva.com/brand/"),
    ).toBeNull();
  });

  it("prefers brand-template URL over a design URL when both appear", () => {
    const skill = `
      design: https://www.canva.com/design/DAGytttEXSY/edit
      brand template: https://www.canva.com/brand/brand-templates/EAHJfsp7GaE
    `;
    expect(extractCanvaTemplateId(skill)).toBe("EAHJfsp7GaE");
  });

  it("extracts brand-template ID from a bare URL", () => {
    expect(
      extractCanvaTemplateId(
        "https://www.canva.com/brand/brand-templates/EAHJfsp7GaE",
      ),
    ).toBe("EAHJfsp7GaE");
  });

  it("extracts brand-template ID from a markdown link", () => {
    expect(
      extractCanvaTemplateId(
        "[Use this template](https://www.canva.com/brand/brand-templates/EAHJfsp7GaE)",
      ),
    ).toBe("EAHJfsp7GaE");
  });
});

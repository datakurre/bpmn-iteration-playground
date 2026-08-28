import { getBusinessObject } from "bpmn-js/lib/util/ModelUtil";
import type { ElementTemplate, TemplateElementType } from "./element-templates-types";

// bpmn-js-create-append-anything's CreateAppendElementTemplatesModule expects the
// `elementTemplates` service to expose `createElement(template)`, which
// bpmn-js-element-templates doesn't provide itself. This factory implements it and
// a tiny module below patches it onto the service, matching the approach used by
// vscode-operaton-bpmn-js-modeler's ExtendElementTemplates.

interface CommandStackLike {
  execute(command: string, context: unknown): void;
}

interface ElementFactoryLike {
  createShape(attrs: { type: string; eventDefinitionType?: string }): unknown;
}

export class TemplateElementFactory {
  static $inject = ["commandStack", "elementFactory"];

  constructor(
    private readonly commandStack: CommandStackLike,
    private readonly elementFactory: ElementFactoryLike,
  ) {}

  create(template: ElementTemplate): unknown {
    const element = this.createShape(template);
    this.setModelerTemplate(element, template);

    this.commandStack.execute("propertiesPanel.camunda.changeTemplate", {
      element,
      oldTemplate: null,
      newTemplate: template,
    });

    return element;
  }

  private createShape(template: ElementTemplate): unknown {
    const { appliesTo, elementType } = template;
    const type: TemplateElementType = elementType || {};
    const targetType = type.value || appliesTo[0];
    if (!targetType) {
      throw new Error(`template "${template.id}" has no elementType.value or appliesTo entries`);
    }
    const attrs: { type: string; eventDefinitionType?: string } = { type: targetType };
    if (type.eventDefinition) {
      attrs.eventDefinitionType = type.eventDefinition;
    }
    return this.elementFactory.createShape(attrs);
  }

  private setModelerTemplate(element: unknown, template: ElementTemplate): void {
    const { id, version, icon } = template;
    const businessObject = getBusinessObject(element);
    businessObject.set("camunda:modelerTemplate", id);
    businessObject.set("camunda:modelerTemplateVersion", version);
    if (icon?.contents) {
      businessObject.set("camunda:modelerTemplateIcon", icon.contents);
    }
  }
}

const templateElementFactoryModule = {
  __init__: ["templateElementFactory"],
  templateElementFactory: ["type", TemplateElementFactory],
};

interface ElementTemplatesServiceLike {
  createElement?: (template: ElementTemplate) => unknown;
}

class ExtendElementTemplates {
  static $inject = ["elementTemplates", "templateElementFactory"];

  constructor(elementTemplates: ElementTemplatesServiceLike, templateElementFactory: TemplateElementFactory) {
    if (elementTemplates.createElement) {
      return;
    }
    elementTemplates.createElement = (template: ElementTemplate) => {
      if (!template) {
        throw new Error("template is missing");
      }
      return templateElementFactory.create(template);
    };
  }
}

// bpmn-js's DI container instantiates `type` entries by class (`new`-ing them), so a
// module whose only job is a constructor side effect (patching the service) is
// registered the same way as any other service.
export const ElementTemplatesExtendModule = {
  __depends__: [templateElementFactoryModule],
  __init__: ["extendedElementTemplates"],
  extendedElementTemplates: ["type", ExtendElementTemplates],
};

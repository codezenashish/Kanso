import { useEffect, useRef, useState, type RefObject } from 'react';

type DocumentSection = {
  heading: HTMLHeadingElement;
  title: string;
  level: number;
  top: number;
};

const headingInset = 12;
const activeSectionInset = 24;
const minimumScrollDistance = 72;

export function DocumentScrollNavigator({ scrollHost }: { scrollHost: RefObject<HTMLDivElement | null> }) {
  const [sections, setSections] = useState<DocumentSection[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const railRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const host = scrollHost.current;
    const editor = host?.querySelector('.visual-markdown');
    if (!host || !editor) return;

    let sections: DocumentSection[] = [];
    let maxScroll = 0;
    let frame = 0;
    let needsMeasurement = false;

    const updateActiveSection = () => {
      const scrollTop = host.scrollTop;
      if (scrollTop >= maxScroll - 1) {
        setActiveIndex(sections.length - 1);
        return;
      }

      const nextIndex = sections.findIndex(({ top }) => top > scrollTop + activeSectionInset);
      let index = (nextIndex === -1 ? sections.length : nextIndex) - 1;
      if (index < 0 && sections[0]?.top < scrollTop + host.clientHeight) index = 0;
      setActiveIndex(index);
    };

    const update = () => {
      frame = 0;
      if (needsMeasurement) {
        needsMeasurement = false;
        maxScroll = host.scrollHeight - host.clientHeight;
        const viewportTop = host.getBoundingClientRect().top;
        const measured = maxScroll < minimumScrollDistance ? [] : Array.from(
          editor.querySelectorAll<HTMLHeadingElement>('h1, h2, h3, h4, h5, h6'),
        ).flatMap((heading) => {
          if (heading.closest('[contenteditable="false"]') || !heading.getClientRects().length) return [];
          return [{
            heading,
            title: heading.innerText.trim() || 'Untitled heading',
            level: Number(heading.tagName.slice(1)),
            top: heading.getBoundingClientRect().top - viewportTop + host.scrollTop,
          }];
        });

        if (measured.length !== sections.length || measured.some((section, index) => {
          const previous = sections[index];
          return section.heading !== previous.heading || section.title !== previous.title || section.top !== previous.top;
        })) {
          sections = measured;
          setSections(sections);
        }
      }
      updateActiveSection();
    };

    const scheduleUpdate = (measure = false) => {
      needsMeasurement ||= measure;
      if (!frame) frame = requestAnimationFrame(update);
    };

    const handleScroll = () => scheduleUpdate();
    const handleLayoutChange = () => scheduleUpdate(true);
    const resizeObserver = new ResizeObserver(handleLayoutChange);
    resizeObserver.observe(host);
    resizeObserver.observe(editor);
    const mutationObserver = new MutationObserver(handleLayoutChange);
    mutationObserver.observe(editor, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden'],
    });
    host.addEventListener('scroll', handleScroll, { passive: true });
    handleLayoutChange();

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      host.removeEventListener('scroll', handleScroll);
      cancelAnimationFrame(frame);
    };
  }, [scrollHost]);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail || rail.matches(':hover, :focus-within')) return;
    const active = rail.querySelector<HTMLElement>('[aria-current="location"]');
    if (!active) return;

    if (active.offsetTop < rail.scrollTop) rail.scrollTop = active.offsetTop;
    const overflow = active.offsetTop + active.offsetHeight - rail.scrollTop - rail.clientHeight;
    if (overflow > 0) rail.scrollTop += overflow;
  }, [activeIndex, sections]);

  if (!sections.length) return null;

  return (
    <nav ref={railRef} className="document-scroll-navigator" aria-label="Document sections">
      {sections.map(({ heading, title, level }, index) => (
        <button
          key={index}
          type="button"
          data-heading-level={level}
          aria-current={activeIndex === index ? 'location' : undefined}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const host = scrollHost.current;
            if (!host?.contains(heading)) return;
            host.scrollTo({
              top: host.scrollTop + heading.getBoundingClientRect().top - host.getBoundingClientRect().top - headingInset,
              behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
            });
          }}
        >
          <span className="document-section-title">{title}</span>
          <span className="document-section-marker" aria-hidden="true" />
        </button>
      ))}
    </nav>
  );
}

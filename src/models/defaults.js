// Named default models (S-expr strings)
export const DEFAULT_MODELS = {
  lizard: `(union
  (paint :color "orange"
    (union
      (translate 5 15 5
        (sphere 5))
      (translate 5 15 -5
        (sphere 5))))
  (intersect
    (union
      (paint :color "green"
        (fuse :k 5
          (translate 18 0 0
            (cube 10))
          (sphere 15)))
      (anti
        (cylinder 8 30)))))`,

  csg: `(union
  (intersect
    (cube 25)
    (sphere 18))
  (translate 40 0 0
    (union
      (cube 20)
      (anti
        (sphere 12))))
  (translate -40 0 0
    (fuse :k 5
      (cube 20)
      (anti
        (sphere 12)))))`,

  cube: `(cube 20)`,

  warps: `(union
  (mirror :axis "x"
    (translate 12 0 0
      (sphere 8)))
  (translate 40 0 0
    (twist :axis "y" :rate 0.15
      (cube 20)))
  (translate -40 0 0
    (radial :axis "y" :count 6
      (translate 12 0 0
        (sphere 5))))
  (translate 0 30 0
    (stretch :sx 2 :sy 0.5 :sz 1
      (sphere 12)))
  (translate 0 -30 0
    (bend :axis "y" :rate 0.04
      (paint :color "green"
        (cube 25))))
  (translate 0 0 40
    (taper :axis "y" :rate 0.03
      (paint :color "orange"
        (cylinder 10 40)))))`,

  pl: `(let "eye"
  (enzyme :tags ("radius")
    (union
      (paint :color "orange"
        (sphere (var "radius")))
      (translate 0 0 2
        (sphere 1))))
  (union
    (let "body"
      (paint :color "green"
        (fuse :k 5
          (sphere 12)
          (translate 15 0 0
            (cube 8))))
      (union
        (var "body")
        (translate 5 12 5
          (stir
            (var "eye")
            (tag "radius" (scalar 3))))
        (translate 5 12 -5
          (stir
            (var "eye")
            (tag "radius" (scalar 3))))))
    (translate 50 0 0
      (grow "acc" :count 6
        (cube 8)
        (union
          (translate 12 4 0 (var "acc"))
          (paint :color "blue"
            (sphere 3)))))))`,

  grow: `(grow "acc" :count 8
  (paint :color "orange"
    (cube 6))
  (union
    (translate 10 5 0 (var "acc"))
    (paint :color "blue"
      (sphere 4))))`,
  fractal: `(fractal :count 3
  (paint :color "green"
    (cube 10))
  (enzyme :tags ("step")
    (enzyme :tags ("shape")
      (union
        (var "shape")
        (translate 12 12 0
          (stretch :sx 0.6 :sy 0.6 :sz 0.6
            (stir
              (var "step")
              (tag "shape"
                (paint :color "orange"
                  (var "shape"))))))
        (translate -12 12 0
          (stretch :sx 0.6 :sy 0.6 :sz 0.6
            (stir
              (var "step")
              (tag "shape"
                (paint :color "blue"
                  (var "shape"))))))))))`,
  menger: `(stir
  (enzyme :tags ("s" "d" "n")
    (fractal :count 2
      (cube 30)
      (enzyme :tags ("step")
        (enzyme :tags ("shape")
              (union
                (translate (var "n") (var "n") (var "n") (stretch :sx (var "s") :sy (var "s") :sz (var "s") (stir (var "step") (tag "shape" (var "shape")))))
                (translate       0  (var "n") (var "n") (stretch :sx (var "s") :sy (var "s") :sz (var "s") (stir (var "step") (tag "shape" (var "shape")))))
                (translate (var "d") (var "n") (var "n") (stretch :sx (var "s") :sy (var "s") :sz (var "s") (stir (var "step") (tag "shape" (var "shape")))))
                (translate (var "n")       0  (var "n") (stretch :sx (var "s") :sy (var "s") :sz (var "s") (stir (var "step") (tag "shape" (var "shape")))))
                (translate (var "d")       0  (var "n") (stretch :sx (var "s") :sy (var "s") :sz (var "s") (stir (var "step") (tag "shape" (var "shape")))))
                (translate (var "n") (var "d") (var "n") (stretch :sx (var "s") :sy (var "s") :sz (var "s") (stir (var "step") (tag "shape" (var "shape")))))
                (translate       0  (var "d") (var "n") (stretch :sx (var "s") :sy (var "s") :sz (var "s") (stir (var "step") (tag "shape" (var "shape")))))
                (translate (var "d") (var "d") (var "n") (stretch :sx (var "s") :sy (var "s") :sz (var "s") (stir (var "step") (tag "shape" (var "shape")))))
                (translate (var "n") (var "n")       0  (stretch :sx (var "s") :sy (var "s") :sz (var "s") (stir (var "step") (tag "shape" (var "shape")))))
                (translate (var "d") (var "n")       0  (stretch :sx (var "s") :sy (var "s") :sz (var "s") (stir (var "step") (tag "shape" (var "shape")))))
                (translate (var "n") (var "d")       0  (stretch :sx (var "s") :sy (var "s") :sz (var "s") (stir (var "step") (tag "shape" (var "shape")))))
                (translate (var "d") (var "d")       0  (stretch :sx (var "s") :sy (var "s") :sz (var "s") (stir (var "step") (tag "shape" (var "shape")))))
                (translate (var "n") (var "n") (var "d") (stretch :sx (var "s") :sy (var "s") :sz (var "s") (stir (var "step") (tag "shape" (var "shape")))))
                (translate       0  (var "n") (var "d") (stretch :sx (var "s") :sy (var "s") :sz (var "s") (stir (var "step") (tag "shape" (var "shape")))))
                (translate (var "d") (var "n") (var "d") (stretch :sx (var "s") :sy (var "s") :sz (var "s") (stir (var "step") (tag "shape" (var "shape")))))
                (translate (var "n")       0  (var "d") (stretch :sx (var "s") :sy (var "s") :sz (var "s") (stir (var "step") (tag "shape" (var "shape")))))
                (translate (var "d")       0  (var "d") (stretch :sx (var "s") :sy (var "s") :sz (var "s") (stir (var "step") (tag "shape" (var "shape")))))
                (translate (var "n") (var "d") (var "d") (stretch :sx (var "s") :sy (var "s") :sz (var "s") (stir (var "step") (tag "shape" (var "shape")))))
                (translate       0  (var "d") (var "d") (stretch :sx (var "s") :sy (var "s") :sz (var "s") (stir (var "step") (tag "shape" (var "shape")))))
                (translate (var "d") (var "d") (var "d") (stretch :sx (var "s") :sy (var "s") :sz (var "s") (stir (var "step") (tag "shape" (var "shape"))))))))))
  (tag "s" (scalar 0.333))
  (tag "d" (scalar 10))
  (tag "n" (scalar -10)))`,
};

export const DEFAULT_MODEL_NAME = 'lizard';
